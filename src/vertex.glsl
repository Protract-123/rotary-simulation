layout(location = 0) in vec4 position;
layout(location = 1) in vec3 rotationAndShaftAngle;
out vec3 viewPosition;

mat2 rotate(float angle) {
    return mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
}

void main() {
    viewPosition = position.xyz;

    if (position.w > 0.0) {
        viewPosition.xy = rotate(rotationAndShaftAngle.z / 3.0) * viewPosition.xy
                        - position.w * rotate(rotationAndShaftAngle.z)[0];
    }

    viewPosition.xz *= rotate(rotationAndShaftAngle.y);
    viewPosition.yz *= rotate(rotationAndShaftAngle.x);

    gl_Position = vec4(viewPosition.xy, -viewPosition.z, 250.0);
}
