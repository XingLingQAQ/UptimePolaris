import { defineWranglerConfig } from "wrangler/experimental-config";
import { fileURLToPath } from "node:url";

export default defineWranglerConfig({
	types: {
		generate: false,
	},
	assetsDirectory: fileURLToPath(new URL("../../public", import.meta.url)),
});
