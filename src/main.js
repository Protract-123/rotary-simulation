import vertexShaderSource from "./vertex.glsl" with { type: "text" };
import fragmentShaderSource from "./fragment.glsl" with { type: "text" };

const { PI, cos, sin, asin, abs, sign, sqrt, hypot, atan2, random, exp } = Math;

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
const PORT_SIZE = 20

// Engine Components
const gear = (radius, teeth) => t => {
    const r = radius + (2 * TEETH_HEIGHT / PI) * asin(sin(teeth * t));
    return [r * cos(t), r * sin(t)];
};

const epitrochoid = t => [cos, sin].map(f => ECCENTRICITY * f(3 * t) + RADIUS * f(t));

const rotorFlank = t => {
    const flankScale = sqrt(1 - RADICAND_COEFF * sin(3 * t) ** 2);

    return [cos, sin].map(f =>
        RADIUS * f(2 * t) + HARMONIC_SHIFT * (f(8 * t) - f(-4 * t)) + ECCENTRICITY * flankScale * (f(5 * t) + f(-t))
    );
};

const epitrochoidCase = epitrochoidPositions => {
    const [peakX, peakY] = epitrochoidPositions.reduce((highest, point) => point[1] > highest[1] ? point : highest);

    const inner = epitrochoidPositions.map(([x, y]) => abs(x) < abs(peakX) ? [x, sign(y) * peakY] : [x, y]);

    return inner.map(([x, y], i) => {
        const [prevX, prevY] = inner[(i + SEGMENTS - 1) % SEGMENTS];
        const [nextX, nextY] = inner[(i + 1) % SEGMENTS];
        const len = hypot(nextX - prevX, nextY - prevY);

        return [
            x + (nextY - prevY) / len * CASE_THICKNESS,
            y - (nextX - prevX) / len * CASE_THICKNESS,
        ];
    });
};

// Model Functions
const positions = [];

const curve = (f, x0 = 0, span = 2 * PI) =>
    Array.from({ length: SEGMENTS + 1 }, (_, i) => f(x0 + span * i / SEGMENTS));

const quad = (a, b, c, d, eccentricity) => {
    for (const [[x, y], z] of [a, b, c, a, c, d]) {
        positions.push(x, y, z, eccentricity);
    }
};

const extrude = (outer, inner, eccentricity = 0, z0 = DEPTH/2, z1 = -z0) => {
    if (inner) extrude(inner, 0, eccentricity, z0, z1);
    for (let i = 0; i < SEGMENTS; i++) {
        const p0 = outer[i], p1 = outer[i + 1];
        const isEdgeOfGap = p0 && !(p1 && outer.at(i - 1));
        if (inner && isEdgeOfGap) quad([p0, z1], [inner[i], z1], [inner[i], z0], [p0, z0], eccentricity);
        if (!p0 || !p1) continue;
        quad([p0, z1], [p1, z1], [p1, z0], [p0, z0], eccentricity);
        if (!inner) continue;
        for (const z of [z1, z0]) {
            quad([p0, z], [p1, z], [inner[i + 1], z], [inner[i], z], eccentricity);
        }
    }
};

// Rendering
const housing = curve(epitrochoid);
const casing = epitrochoidCase(housing);

for (const s of [-1, 1]) extrude(housing, casing, 0, s * (DEPTH / 2), s * PORT_SIZE);
housing.map(([x, y], i) => y > 0 && abs(abs(x) - 70) < 10 && (housing[i] = casing[i] = 0));
extrude(housing, casing, 0, PORT_SIZE);

extrude(curve(gear(2 * ECCENTRICITY, TEETH_COUNT)), curve(() => [0, 0]));    // stationary gear

const internalGear = gear(3 * ECCENTRICITY, ROTOR_TEETH);
for (let flank = 0; flank < 3; flank++) {
    const rotor = curve(rotorFlank, PI / 6 + flank * 2 * PI / 3, PI / 3);
    extrude(rotor, rotor.map(([x, y]) => internalGear(atan2(y, x))), ECCENTRICITY);
}

c.width = c.height = 800 * devicePixelRatio;
const gl = c.getContext('webgl2');

const program = gl.createProgram();
[vertexShaderSource, fragmentShaderSource].forEach((source, index) => {
    const shader = gl.createShader(gl.VERTEX_SHADER - index);
    gl.shaderSource(shader, "#version 300 es\n" + source);
    gl.compileShader(shader);

    // Development only, removed by build script.
    if (import.meta.hot && !gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
    }

    gl.attachShader(program, shader);
});
gl.linkProgram(program);
gl.useProgram(program);

const positionLocation = 0;
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
gl.enableVertexAttribArray(positionLocation);
gl.vertexAttribPointer(positionLocation, 4, gl.FLOAT, false, 0, 0);

const rotationAndShaftAngleLocation = 1;

gl.enable(gl.DEPTH_TEST);

let xrot = 0
let yrot = 0

let rps = 0;
let throttle = 0;

let shaftAngle = 0
let drawType = gl.TRIANGLES;

const draw = () => {
    f.innerText = `mouse = rotate\nclick = start\nw/s = accel\nt/r = mode\nRPM = ${rps * 9.549 | 0}`
    gl.vertexAttrib3f(rotationAndShaftAngleLocation, xrot, yrot, shaftAngle)
    gl.drawArrays(drawType, 0, positions.length / 4);
    requestAnimationFrame(draw);
};

draw();

// Audio

const audioContext = new AudioContext({sampleRate: 48000});
const soundProcessor = audioContext.createScriptProcessor(256, 0, 1)
soundProcessor.connect(audioContext.destination);

let soundPhase = 0;
let timingJitter = 1;
let lowCut = 0;
let resonanceLow = 0;
let resonanceBand = 0;
let edgeLowpass = 0;
let edgeSmooth = 0;


soundProcessor.onaudioprocess = event => {
    const output = event.outputBuffer.getChannelData(0)
    for (let i = 0; i < output.length; ++i) {
        shaftAngle += rps / 48000
        rps += throttle / 480
        rps = rps < 1.1 ? 1.1 : (rps > 1256.7 ? 1256.7 : rps)

        const phase = (shaftAngle / (2 * PI) + .75) % 1;
        if (phase < soundPhase) timingJitter = (random() - .5) / 50;
        soundPhase = phase;

        const pulses =  (exp(-13 * (phase+timingJitter)));

        lowCut += .05 * (pulses - lowCut);
        resonanceLow += .03 * resonanceBand;
        resonanceBand += .03 * (pulses - lowCut - resonanceLow - .12 * resonanceBand);
        edgeLowpass += .1 * (pulses - edgeLowpass);
        edgeSmooth += .4 * (pulses - edgeSmooth);

        output[i] = 2 * resonanceLow + .3 * (edgeLowpass - edgeSmooth);
    }
}

// Interactivity

onmousemove = event => {
    xrot = (.5 - event.y / innerHeight) * PI;
    yrot = (event.x / innerWidth - .5) * PI
}

onclick = () => {
    rps ||= 1; audioContext.resume();
}

onkeydown = event => {
    throttle = { w: 1, s: -1 }[event.key] || 0;
    drawType = {t: gl.TRIANGLES, r: gl.LINES}[event.key] || drawType
}

onkeyup = () => throttle = 0