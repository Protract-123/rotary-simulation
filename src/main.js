import vertexShaderSource from "./vertex.glsl" with { type: "text" };
import fragmentShaderSource from "./fragment.glsl" with { type: "text" };

const { PI, cos, sin, asin, abs, sign, sqrt, hypot, atan2 } = Math;

// Rotor Constants
const RADIUS = 160
const ECCENTRICITY = 24

const TEETH_COUNT = 16
const TEETH_HEIGHT = 2 * ECCENTRICITY/TEETH_COUNT
const ROTOR_TEETH = 1.5 * TEETH_COUNT;

const RATIO = 3 * ECCENTRICITY / RADIUS;
const HARMONIC_SHIFT = RATIO * ECCENTRICITY / 2;
const RADICAND_COEFF = RATIO ** 2;

// Model Constants
const SEGMENTS = 1000;
const DEPTH = 70;
const CASE_THICKNESS = 10

// Engine Components
const gear = (radius, teeth) => t => {
    const r = radius + (2 * TEETH_HEIGHT / PI) * asin(sin(teeth * t));
    return [r * cos(t), r * sin(t)];
};

const epitrochoid = t => [
    ECCENTRICITY * cos(3 * t) + RADIUS * cos(t),
    ECCENTRICITY * sin(3 * t) + RADIUS * sin(t)
];

function rotorFlank(t) {
    const flankScale = sqrt(1 - RADICAND_COEFF * sin(3 * t) ** 2);

    return [
        RADIUS * cos(2 * t) + HARMONIC_SHIFT * (cos(8 * t) - cos(4 * t)) + ECCENTRICITY * flankScale * (cos(5 * t) + cos(t)),
        RADIUS * sin(2 * t) + HARMONIC_SHIFT * (sin(8 * t) + sin(4 * t)) + ECCENTRICITY * flankScale * (sin(5 * t) - sin(t))
    ];
}

function epitrochoidCase(epitrochoidPositions) {
    let peakY = -Infinity, peakX = 0

    for (const [x, y] of epitrochoidPositions) {
        if (y > peakY) {
            peakY = y;
            peakX = abs(x)
        }
    }

    const inner = epitrochoidPositions.map(([x, y]) => {
        if (abs(x) < peakX) return [x, sign(y) * peakY]
        return [x, y]
    })

    const n = inner.length - 1
    const outer = []

    for (let i = 0; i < n; i++) {
        const prev = inner[(i - 1 + n) % n]
        const next = inner[(i + 1) % n]
        const tx = next[0] - prev[0]
        const ty = next[1] - prev[1]
        const len = hypot(tx, ty)

        outer.push([
            inner[i][0] + ty / len * CASE_THICKNESS,
            inner[i][1] - tx / len * CASE_THICKNESS,
        ])
    }
    outer.push(outer[0])

    return outer
}

// Model Functions
const positions = [];

function curve(f, x0 = 0, span = 2 * PI) {
    const points = [];
    for (let i = 0; i <= SEGMENTS; i++) {
        points.push(f(x0 + span * i / SEGMENTS));
    }
    return points;
}

function quad(a, b, c, d, eccentricity) {
    for (const [[x, y], z] of [a, b, c, a, c, d]) {
        positions.push(x, y, z, eccentricity);
    }
}

function extrude(outer, inner, eccentricity = 0) {
    const h = DEPTH / 2;
    if (inner) extrude(inner, null, eccentricity);
    for (let i = 0; i < SEGMENTS; i++) {
        const p0 = outer[i], p1 = outer[i + 1];
        quad([p0, -h], [p1, -h], [p1, h], [p0, h], eccentricity);
        if (!inner) continue;
        for (const z of [-h, h]) {
            quad([p0, z], [p1, z], [inner[i + 1], z], [inner[i], z], eccentricity);
        }
    }
}

// Rendering
const housing = curve(epitrochoid);
extrude(housing, epitrochoidCase(housing));
extrude(curve(gear(2 * ECCENTRICITY, TEETH_COUNT)), curve(() => [0, 0, 0]));    // stationary gear

const internalGear = gear(3 * ECCENTRICITY, ROTOR_TEETH);
for (let flank = 0; flank < 3; flank++) {
    const rotor = curve(rotorFlank, PI / 6 + flank * 2 * PI / 3, PI / 3);
    extrude(rotor, rotor.map(([x, y]) => internalGear(atan2(y, x))), ECCENTRICITY);
}

const canvas = c;
canvas.width = canvas.height = 800 * devicePixelRatio;
const gl = canvas.getContext('webgl2');

const program = gl.createProgram();
for (const [type, source] of [[gl.VERTEX_SHADER, vertexShaderSource], [gl.FRAGMENT_SHADER, fragmentShaderSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    // Development only, removed by build script.
    if (import.meta.hot && !gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
    }

    gl.attachShader(program, shader);
}
gl.linkProgram(program);
gl.useProgram(program);

const positionLoc = gl.getAttribLocation(program, 'position');
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
gl.enableVertexAttribArray(positionLoc);
gl.vertexAttribPointer(positionLoc, 4, gl.FLOAT, false, 0, 0);

const timeUniform = gl.getUniformLocation(program, 'time');
const rotationUniform = gl.getUniformLocation(program, 'rotation');
const rpsUniform = gl.getUniformLocation(program, 'rps');

gl.enable(gl.DEPTH_TEST);

let xrot = 0
let yrot = 0
let rps = 2*PI // 60RPM
let scrollDirection = 0;

function draw(timeMs) {
    if (scrollDirection === -1) rps /= 2
    else if (scrollDirection === 1) rps *= 2
    scrollDirection = 0

    gl.uniform1f(timeUniform, timeMs / 1000);
    gl.uniform2f(rotationUniform, xrot, yrot)
    gl.uniform1f(rpsUniform, rps)

    gl.drawArrays(gl.TRIANGLES, 0, positions.length / 4);
    requestAnimationFrame(draw);
}

requestAnimationFrame(draw);

onmousemove = event => {
    xrot = (.5 - event.y / innerHeight) * PI;
    yrot = (event.x / innerWidth - .5) * PI
}

onwheel = event => scrollDirection = sign(event.deltaY)
