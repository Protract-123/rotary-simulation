#version 300 es

precision highp float;
in vec3 viewPosition;
out vec4 color;

void main() {
    vec3 normal = normalize(cross(dFdx(viewPosition), dFdy(viewPosition)));

    // light direction: normalize(vec3(0.5, 0.7, 1.0))
    float brightness = 0.3 + 0.7 * max(dot(normal, vec3(0.379, 0.531, 0.758)), 0.0);
    color = vec4(vec3(0.8196, 0.8275, 0.8235) * brightness, 1.0);
}
