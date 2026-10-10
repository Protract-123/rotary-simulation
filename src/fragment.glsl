precision highp float;
in vec3 viewPosition;
out vec4 color;

void main() {
    vec3 normal = normalize(cross(dFdx(viewPosition), dFdy(viewPosition)));
    color = vec4(
        mix(
            vec3(0.060, 0.070, 0.100),
            mix(
                vec3(0.26, 0.31, 0.48),
                vec3(0.82, 0.79, 0.71),
                dot(smoothstep(-0.06, 0.06, dot(normal, vec3(0.38, 0.53, 0.76)) - vec3(0.25, 0.5, 0.75)), vec3(0.333))
            ),
            smoothstep(0.04, 0.2, normal.z)
        ),
        1
    );
}
