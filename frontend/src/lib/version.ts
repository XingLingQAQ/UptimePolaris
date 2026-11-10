/** Vite injects the version without bundling package.json. / Vite 注入版本号，无需打包 package.json。 */
export const APP_VERSION: string = __APP_VERSION__;

declare const __APP_VERSION__: string;
