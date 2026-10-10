import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { minify } from "terser";

const BYTE_LIMIT = 3072;

type GlslToken = { kind: "space" | "comment" | "directive" | "number" | "name" | "symbol"; text: string };

const GLSL_TOKEN_PATTERNS: [GlslToken["kind"], RegExp][] = [
    ["space", /\s+/y],
    ["comment", /\/\/.*|\/\*[\s\S]*?\*\//y],
    ["directive", /#.*/y],
    ["number", /0x[\da-f]+u?|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?[uf]?/iy],
    ["name", /[A-Za-z_]\w*/y],
    ["symbol", /./y],
];

const MULTI_CHARACTER_OPERATORS = [
    "<<=", ">>=",
    "++", "--", "&&", "||", "^^", "<<", ">>",
    "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
];

const GLSL_TYPES = new Set([
    "void", "bool", "int", "uint", "float",
    ...["vec", "bvec", "ivec", "uvec"].flatMap(vector => [vector + 2, vector + 3, vector + 4]),
    "mat2", "mat3", "mat4", "mat2x3", "mat2x4", "mat3x2", "mat3x4", "mat4x2", "mat4x3",
]);

const GLSL_KEYWORDS = ["do", "if", "in"];

function tokenizeGlsl(glsl: string) {
    const tokens: GlslToken[] = [];
    let position = 0;
    while (position < glsl.length) {
        for (const [kind, pattern] of GLSL_TOKEN_PATTERNS) {
            pattern.lastIndex = position;
            const match = pattern.exec(glsl);
            if (!match) continue;

            const operator = kind === "symbol"
                ? MULTI_CHARACTER_OPERATORS.find(op => glsl.startsWith(op, position))
                : undefined;
            const text = operator ?? match[0];
            tokens.push({ kind, text });
            position += text.length;
            break;
        }
    }
    return tokens;
}

function stripGlsl(glsl: string) {
    return tokenizeGlsl(glsl).filter(token => token.kind !== "space" && token.kind !== "comment");
}

const isGlslType = (name: string) => GLSL_TYPES.has(name) || name.startsWith("sampler");
const isMemberAccess = (tokens: GlslToken[], index: number) => tokens[index - 1]?.text === ".";

function findDeclaredNames(tokens: GlslToken[]) {
    const declaredNames = new Set<string>();
    let insideVariableDeclaration = false;
    let bracketDepth = 0;

    tokens.forEach((token, index) => {
        const previousText = tokens[index - 1]?.text ?? "";
        const followsType = isGlslType(previousText);
        const followsDeclarationComma = insideVariableDeclaration && bracketDepth === 0 && previousText === ",";

        if (token.kind === "name" && !isGlslType(token.text) && (followsType || followsDeclarationComma)) {
            declaredNames.add(token.text);
            const declaresFunction = tokens[index + 1]?.text === "(";
            if (followsType && !declaresFunction) {
                insideVariableDeclaration = true;
                bracketDepth = 0;
            }
            return;
        }

        if (!insideVariableDeclaration) return;
        if (token.text === "(" || token.text === "[") bracketDepth++;
        if (token.text === ")" || token.text === "]") bracketDepth--;
        const reachedEndOfStatement = token.text === ";" && bracketDepth === 0;
        const reachedEndOfParameterList = bracketDepth < 0;
        if (reachedEndOfStatement || reachedEndOfParameterList) insideVariableDeclaration = false;
    });

    declaredNames.delete("main");
    return declaredNames;
}

function* generateShortNames() {
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const first of letters) yield first;
    for (const first of letters) for (const second of letters) yield first + second;
}

function shortenNumberLiteral(literal: string) {
    if (!literal.includes(".")) return literal;
    const [mantissa, exponent = ""] = literal.split(/(?=e)/i);
    const [wholePart, fractionPart] = mantissa!.split(".") as [string, string];
    const whole = wholePart.replace(/^0+/, "");
    const fraction = fractionPart.replace(/0+$/, "");
    return (whole || fraction ? whole : "0") + "." + fraction + exponent;
}

function tokensWouldMerge(left: GlslToken, right: GlslToken) {
    const isWordLike = (token: GlslToken) => token.kind === "name" || token.kind === "number";
    if (isWordLike(left) && isWordLike(right)) return true;
    if (left.kind !== "symbol" || right.kind !== "symbol") return false;

    const operatorReadBack = MULTI_CHARACTER_OPERATORS.find(op => (left.text + right.text).startsWith(op));
    return operatorReadBack !== undefined && operatorReadBack.length > left.text.length;
}

function collapseDirective(directive: string) {
    const withoutTrailingComment = directive.replace(/\/\/.*/, "");
    return withoutTrailingComment.replace(/\s+/g, " ").trim();
}

function createGlslMinifier(allShaderSources: string[]) {
    const tokenizedShaders = allShaderSources.map(stripGlsl);
    const declaredNames = new Set(tokenizedShaders.flatMap(tokens => [...findDeclaredNames(tokens)]));

    const useCounts = new Map<string, number>();
    const unavailableNames = new Set(GLSL_KEYWORDS);
    for (const tokens of tokenizedShaders) {
        tokens.forEach((token, index) => {
            if (token.kind !== "name" || isMemberAccess(tokens, index)) return;
            if (declaredNames.has(token.text)) useCounts.set(token.text, (useCounts.get(token.text) ?? 0) + 1);
            else unavailableNames.add(token.text);
        });
    }

    const renames = new Map<string, string>();
    const shortNames = generateShortNames();
    const mostUsedFirst = [...useCounts].sort(([, a], [, b]) => b - a).map(([name]) => name);
    for (const name of mostUsedFirst) {
        let shortName = shortNames.next().value!;
        while (unavailableNames.has(shortName)) shortName = shortNames.next().value!;
        renames.set(name, shortName);
    }

    function minifyToken(token: GlslToken, isMember: boolean): GlslToken {
        if (token.kind === "number") return { ...token, text: shortenNumberLiteral(token.text) };
        if (token.kind === "name" && !isMember) return { ...token, text: renames.get(token.text) ?? token.text };
        return token;
    }

    function minifyShader(code: string) {
        const tokens = stripGlsl(code);
        let output = "";
        let previous: GlslToken | undefined;

        tokens.forEach((token, index) => {
            if (token.kind === "directive") {
                if (output && !output.endsWith("\n")) output += "\n";
                output += collapseDirective(token.text) + "\n";
                previous = undefined;
                return;
            }

            const minified = minifyToken(token, isMemberAccess(tokens, index));
            if (previous && tokensWouldMerge(previous, minified)) output += " ";
            output += minified.text;
            previous = minified;
        });

        return output.trim();
    }

    return { minifyShader, renames };
}

const WEBGL_CONSTANTS: Record<string, number> = {
    ARRAY_BUFFER: 34962,
    BLEND: 3042,
    COLOR_BUFFER_BIT: 16384,
    COMPILE_STATUS: 35713,
    CULL_FACE: 2884,
    DEPTH_BUFFER_BIT: 256,
    DEPTH_TEST: 2929,
    DYNAMIC_DRAW: 35048,
    ELEMENT_ARRAY_BUFFER: 34963,
    FLOAT: 5126,
    FRAGMENT_SHADER: 35632,
    LINK_STATUS: 35714,
    STATIC_DRAW: 35044,
    TRIANGLES: 4,
    LINES: 1,
    TRIANGLE_STRIP: 5,
    UNSIGNED_SHORT: 5123,
    VERTEX_SHADER: 35633,
};

const WEBGL_CONTEXT_ASSIGNMENT = /(\w+) = \w+\.getContext\(/g;
const ATTRIBUTE_OR_UNIFORM_LOOKUP = /(getAttribLocation|getUniformLocation)\((\w+), "(\w+)"\)/g;

function webglConstantValue(contextName: string, constantName: string) {
    const value = WEBGL_CONSTANTS[constantName];
    if (value === undefined) {
        throw new Error(`Unknown WebGL constant ${contextName}.${constantName}: add its value to WEBGL_CONSTANT_VALUES`);
    }
    return value;
}

function inlineWebglConstants(js: string) {
    for (const [, contextName] of js.matchAll(WEBGL_CONTEXT_ASSIGNMENT)) {
        const constantAccess = new RegExp(`\\b${contextName}\\.([A-Z0-9_]+)\\b`, "g");
        js = js.replace(constantAccess, (_, constantName: string) => String(webglConstantValue(contextName!, constantName)));
    }
    return js;
}

function renameWebglLookups(js: string, shaderRenames: Map<string, string>) {
    return js.replace(ATTRIBUTE_OR_UNIFORM_LOOKUP, (_, method: string, program: string, name: string) => {
        const renamed = shaderRenames.get(name);
        if (!renamed) throw new Error(`${method}(${program}, "${name}"): no shader declares "${name}"`);
        return `${method}(${program}, "${renamed}")`;
    });
}

const shaderPaths = [...new Bun.Glob("src/**/*.glsl").scanSync()];
const glsl = createGlslMinifier(shaderPaths.map(path => readFileSync(path, "utf8")));

const minifyImportedShaders: BunPlugin = {
    name: "minify-glsl",
    setup(build) {
        build.onLoad({ filter: /\.glsl$/ }, async ({ path }) => ({
            contents: glsl.minifyShader(await Bun.file(path).text()),
            loader: "text",
        }));
    },
};

const globalElementIDs: string[] = [];
const scriptSources: string[] = [];

const strippedPage = new HTMLRewriter()
    .onDocument({ comments: comment => void comment.remove() })
    .on("[id]", { element: element => void globalElementIDs.push(element.getAttribute("id")!) })
    .on("script[src]", { element: element => void scriptSources.push(element.getAttribute("src")!) })
    .transform(readFileSync("src/index.html", "utf8"))
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    .trim();

async function bundleAndMinifyScript(entryPath: string) {
    const result = await Bun.build({ entrypoints: [entryPath], target: "browser", plugins: [minifyImportedShaders] });
    if (!result.success) throw new AggregateError(result.logs, "Bundle failed: " + entryPath);

    const bundled = await result.outputs[0]!.text();
    const withShaderNamesFollowed = renameWebglLookups(inlineWebglConstants(bundled), glsl.renames);

    const { code } = await minify(withShaderNamesFollowed, {
        toplevel: true,
        compress: { passes: 3 },
        mangle: { reserved: globalElementIDs },
    });
    return code!;
}

const minifiedScripts = new Map<string, string>();
for (const src of scriptSources) minifiedScripts.set(src, await bundleAndMinifyScript(join("src", src)));

const html = new HTMLRewriter()
    .on("script[src]", {
        element(script) {
            const code = minifiedScripts.get(script.getAttribute("src")!)!;
            script.replace(`<script>${code}</script>`, { html: true });
        },
    })
    .transform(strippedPage);

function escapeBrokenCharacters(html: string) {
    return html.replaceAll("%", "%25").replaceAll("#", "%23").replaceAll("\n", "%0A");
}

function createDataUri(html: string) {
    return "data:text/html," + escapeBrokenCharacters(html);
}

const uri = createDataUri(html);

mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
writeFileSync("dist/uri.txt", uri);

const bytes = Buffer.byteLength(uri);
const remaining = BYTE_LIMIT - bytes;
console.log(`${bytes} / ${BYTE_LIMIT} bytes, ` + (remaining < 0 ? `${-remaining} over` : `${remaining} left`));
