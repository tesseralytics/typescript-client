declare const __TESSERA_VERSION__: string | undefined;

/** Package version, injected at build time (falls back to `"dev"` outside a built bundle). */
export const VERSION: string = typeof __TESSERA_VERSION__ === "string" ? __TESSERA_VERSION__ : "dev";
