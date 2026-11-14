import { bindings, defineConfig, triggers } from "cf/config";
import { fileURLToPath } from "node:url";

/**
 * Secret-like files were detected but not read or migrated: .dev.vars. Only `secrets.required` entries are migrated.
 * 检测到类似密钥的文件但未读取或迁移：.dev.vars。仅迁移 `secrets.required` 条目。
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	worker: {
		name: "uptime-polaris",
		compatibilityDate: "2025-01-01",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
		observability: {
			enabled: true,
		},
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "single-page-application",
			runWorkerFirst: [
				"/api", "/api/*", "/install.sh", "/install.ps1",
				"/", "/admin", "/admin/*", "/login", "/login/*", "/setup", "/setup/*",
				"/monitor/*", "/status/*", "/server/*",
				"/theme/*", "/polaris-maintenance.js", "/agent/*", "/__scheduled"
			],
		},
		triggers: [
			triggers.scheduled({
				schedule: "* * * * *",
			}),
			triggers.scheduled({
				schedule: "10 0 * * *",
			}),
		],
		env: {
			// CONFIG: bindings.kv({ id: "<KV namespace ID>" }),
			PBKDF2_ITERATIONS: bindings.text("3000"),
			DATABASE_TYPE: bindings.text("d1"),
			/**
			 * Analytics Engine, which must be enabled once in the dashboard
			 * before any deploy that includes this binding - Cloudflare rejects
			 * one with `[10089]` until then and no CLI call can do it.
			 * 必须先在控制台启用 Analytics Engine，才能部署此绑定；否则 Cloudflare
			 * 会返回 `[10089]`，且无法通过 CLI 启用。
			 */
			UPTIME: bindings.analyticsEngineDataset({
				name: "uptime_heartbeats",
			}),
			DB: bindings.d1({
				name: "uptime",
				id: "f9e63017-43c7-4176-a32d-8366c17ab694",
			}),
			THEMES: bindings.r2({
				name: "uptime-themes",
			}),
			ASSETS: bindings.assets(),
		},
	},
});
