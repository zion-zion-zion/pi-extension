// Subtle ambient post-processing for a light, Kimi-inspired Herdr in Ghostty.
// This intentionally avoids blur, distortion, and animation so terminal text stays crisp.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 source = texture(iChannel0, uv);

    // A barely warm color lift across the whole terminal surface.
    vec3 warm = source.rgb * vec3(1.006, 1.003, 0.998);

    // Very light edge falloff gives the window a softer surface without
    // changing the layout or trying to identify Herdr's individual panes.
    vec2 centered = uv * 2.0 - 1.0;
    centered.x *= iResolution.x / iResolution.y;
    float edge = max(abs(centered.x), abs(centered.y));
    float vignette = smoothstep(0.78, 1.05, edge) * 0.035;

    vec3 color = mix(source.rgb, warm, 0.18);
    color *= 1.0 - vignette;
    fragColor = vec4(color, source.a);
}
