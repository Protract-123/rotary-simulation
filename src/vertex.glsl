#version 300 es

in vec4 position; // w: eccentricity
uniform float time;
uniform vec2 rotation;
uniform float rps;
out vec3 viewPosition;

mat2 rotate(float angle) {
    return mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
}

void main() {
    vec3 pos = position.xyz;

    // Rotor parts turn at a third of shaft speed while orbiting the shaft.
    if (position.w > 0.0) {
        float shaft = rps * time;
        pos.xy = rotate(shaft / 3.0 + 1.0472) * pos.xy    // + PI / 3
               + position.w * vec2(cos(shaft), sin(shaft));
    }

    pos.xz *= rotate(rotation.y);    // y axis rotation
    pos.yz *= rotate(rotation.x);    // x axis rotation

    viewPosition = pos;
    gl_Position = vec4(pos.xy / 250.0, -pos.z / 400.0, 1.0);
}
