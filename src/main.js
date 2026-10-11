import vertexShaderSource from "./vertex.glsl" with { type: "text" };
import fragmentShaderSource from "./fragment.glsl" with { type: "text" };

const { PI, cos, sin, asin, abs, sign, sqrt, hypot, atan2, random, exp } = Math;

// Rotor Constants
const RADIUS = 160;
const ECCENTRICITY = 24;

const STATIONARY_GEAR_TEETH = 16;
const INTERNAL_GEAR_TEETH = 1.5 * STATIONARY_GEAR_TEETH;
const TOOTH_HEIGHT = 2 * ECCENTRICITY / STATIONARY_GEAR_TEETH;

const RATIO = 3 * ECCENTRICITY / RADIUS;
const HARMONIC_SHIFT = RATIO * ECCENTRICITY / 2;
const RADICAND_COEFFICIENT = RATIO ** 2;

// Model Constants
const SEGMENTS = 1000;
const DEPTH = 70;
const CASE_THICKNESS = 10;
const PORT_SIZE = 20;
const PORT_OFFSET = 70;
const PORT_HALF_WIDTH = 10;

// Simulation Constants
const CANVAS_SIZE = 800;
const SAMPLE_RATE = 48000;
const AUDIO_BUFFER_SIZE = 256;
const ACCELERATION = 100;
const MIN_SHAFT_SPEED = 1.1;
const MAX_SHAFT_SPEED = 1256.7;
const RADIANS_PER_SECOND_TO_RPM = 9.549;

// Engine Components
const gear = (radius, teeth) => t => {
    const toothedRadius = radius + (2 * TOOTH_HEIGHT / PI) * asin(sin(teeth * t));
    return [toothedRadius * cos(t), toothedRadius * sin(t)];
};

const epitrochoid = t => [cos, sin].map(trig => ECCENTRICITY * trig(3 * t) + RADIUS * trig(t));

const rotorFlank = t => {
    const flankScale = sqrt(1 - RADICAND_COEFFICIENT * sin(3 * t) ** 2);

    return [cos, sin].map(trig =>
        RADIUS * trig(2 * t) + HARMONIC_SHIFT * (trig(8 * t) - trig(-4 * t)) + ECCENTRICITY * flankScale * (trig(5 * t) + trig(-t))
    );
};

const epitrochoidCase = epitrochoidPositions => {
    const [peakX, peakY] = epitrochoidPositions.reduce((highest, point) => point[1] > highest[1] ? point : highest);

    const inner = epitrochoidPositions.map(([x, y]) => abs(x) < abs(peakX) ? [x, sign(y) * peakY] : [x, y]);

    return inner.map(([x, y], i) => {
        const [prevX, prevY] = inner[(i + SEGMENTS - 1) % SEGMENTS];
        const [nextX, nextY] = inner[(i + 1) % SEGMENTS];
        const length = hypot(nextX - prevX, nextY - prevY);

        return [
            x + (nextY - prevY) / length * CASE_THICKNESS,
            y - (nextX - prevX) / length * CASE_THICKNESS
        ];
    });
};

// Model Functions
const positions = [];

const curve = (shape, t0 = 0, span = 2 * PI) =>
    Array.from({ length: SEGMENTS + 1 }, (_, i) => shape(t0 + span * i / SEGMENTS));

const quad = (p, q, r, s, eccentricity) => {
    for (const [[x, y], z] of [p, q, r, p, r, s]) {
        positions.push(x, y, z, eccentricity);
    }
};

const extrude = (outer, inner, eccentricity = 0, z0 = DEPTH / 2, z1 = -z0) => {
    if (inner) extrude(inner, 0, eccentricity, z0, z1);
    for (let i = 0; i < SEGMENTS; i++) {
        const p0 = outer[i];
        const p1 = outer[i + 1];
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

for (const side of [-1, 1]) {
    extrude(housing, casing, 0, side * (DEPTH / 2), side * PORT_SIZE);
}
housing.map(([x, y], i) => y > 0 && abs(abs(x) - PORT_OFFSET) < PORT_HALF_WIDTH && (housing[i] = casing[i] = 0));
extrude(housing, casing, 0, PORT_SIZE);

const stationaryGear = curve(gear(2 * ECCENTRICITY, STATIONARY_GEAR_TEETH));
extrude(stationaryGear, curve(() => [0, 0]));

const internalGear = gear(3 * ECCENTRICITY, INTERNAL_GEAR_TEETH);
for (let flank = 0; flank < 3; flank++) {
    const flankOutline = curve(rotorFlank, PI / 6 + flank * 2 * PI / 3, PI / 3);
    extrude(flankOutline, flankOutline.map(([x, y]) => internalGear(atan2(y, x))), ECCENTRICITY);
}

c.width = c.height = CANVAS_SIZE * devicePixelRatio;
const gl = c.getContext("webgl2");

const program = gl.createProgram();
[vertexShaderSource, fragmentShaderSource].map((source, index) => {
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

let rotationX = 0;
let rotationY = 0;

let shaftSpeed = 0;
let throttle = 0;

let shaftAngle = 0;
let drawType = gl.TRIANGLES;

const draw = () => {
    f.innerText = `mouse = rotate\nclick = start\nw/s = accel\nt/r = mode\nRPM = ${shaftSpeed * RADIANS_PER_SECOND_TO_RPM | 0}`;
    gl.vertexAttrib3f(rotationAndShaftAngleLocation, rotationX, rotationY, shaftAngle);
    gl.drawArrays(drawType, 0, positions.length / 4);
    requestAnimationFrame(draw);
};

draw();

// Audio
const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
const soundProcessor = audioContext.createScriptProcessor(AUDIO_BUFFER_SIZE, 0, 1);
soundProcessor.connect(audioContext.destination);

let soundPhase = 0;
let timingJitter = 1;
let lowCut = 0;
let resonanceLow = 0;
let resonanceBand = 0;
let edgeLowpass = 0;
let edgeSmooth = 0;

soundProcessor.onaudioprocess = event => {
    const output = event.outputBuffer.getChannelData(0);
    for (let i = 0; i < output.length; i++) {
        shaftAngle += shaftSpeed / SAMPLE_RATE;
        shaftSpeed += throttle * ACCELERATION / SAMPLE_RATE;
        shaftSpeed = shaftSpeed < MIN_SHAFT_SPEED ? MIN_SHAFT_SPEED : (shaftSpeed > MAX_SHAFT_SPEED ? MAX_SHAFT_SPEED : shaftSpeed);

        const phase = (shaftAngle / (2 * PI) + 0.75) % 1;
        if (phase < soundPhase) timingJitter = (random() - 0.5) / 50;
        soundPhase = phase;

        const pulses = exp(-13 * (phase + timingJitter));

        lowCut += 0.05 * (pulses - lowCut);
        resonanceLow += 0.03 * resonanceBand;
        resonanceBand += 0.03 * (pulses - lowCut - resonanceLow - 0.12 * resonanceBand);
        edgeLowpass += 0.1 * (pulses - edgeLowpass);
        edgeSmooth += 0.4 * (pulses - edgeSmooth);

        output[i] = 2 * resonanceLow + 0.3 * (edgeLowpass - edgeSmooth);
    }
};

// Interactivity
onmousemove = event => {
    rotationX = (0.5 - event.y / innerHeight) * PI;
    rotationY = (event.x / innerWidth - 0.5) * PI;
};

onclick = () => {
    shaftSpeed ||= MIN_SHAFT_SPEED;
    audioContext.resume();
};

onkeydown = event => {
    throttle = { w: 1, s: -1 }[event.key] || 0;
    drawType = { t: gl.TRIANGLES, r: gl.LINES }[event.key] || drawType;
};

onkeyup = () => {
    throttle = 0;
};
