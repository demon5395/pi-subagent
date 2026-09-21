import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 包内预装 agent 目录（相对于本文件所在目录的上级 agents/）。
 *
 * 在运行时通过 import.meta.url 定位，确保打包后路径仍然正确。
 */
function getBundledAgentsDir(): string {
	// __dirname 在 ESM 中不可用，通过 import.meta.url 计算
	const thisFile = fileURLToPath(import.meta.url);
	const subagentDir = path.dirname(thisFile); // .../subagent/
	const packageDir = path.dirname(subagentDir); // .../pi-subagent/
	return path.join(packageDir, "agents");
}

/**
 * 将包内预装的 agent 文件复制到用户 agents 目录。
 *
 * - 目录不存在则自动创建
 * - 已有同名文件绝不覆盖（用户自定义优先）
 * - 返回本次复制的文件名列表
 */
export function ensureExampleAgents(userAgentsDir: string): string[] {
	try {
		const bundledDir = getBundledAgentsDir();

		// 包内 agents 目录必须存在
		if (!fs.existsSync(bundledDir)) {
			return [];
		}

		// 确保用户 agents 目录存在
		if (!fs.existsSync(userAgentsDir)) {
			fs.mkdirSync(userAgentsDir, { recursive: true });
		}

		const created: string[] = [];

		const entries = fs.readdirSync(bundledDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			const targetPath = path.join(userAgentsDir, entry.name);
			if (fs.existsSync(targetPath)) {
				continue; // 已有文件，不覆盖
			}

			const sourcePath = path.join(bundledDir, entry.name);
			try {
				fs.copyFileSync(sourcePath, targetPath);
				created.push(entry.name.replace(/\.md$/, ""));
			} catch {
				// 单个文件复制失败，不影响其他文件
				continue;
			}
		}

		return created;
	} catch {
		return []; // 静默失败，不影响扩展加载
	}
}

/**
 * 返回包内所有预装 agent 的元信息，用于 README 展示。
 */
export function listBundledAgents(): { name: string; description: string }[] {
	try {
		const bundledDir = getBundledAgentsDir();
		if (!fs.existsSync(bundledDir)) return [];

		const agents: { name: string; description: string }[] = [];
		const entries = fs.readdirSync(bundledDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			const filePath = path.join(bundledDir, entry.name);
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const match = content.match(/^---\n([\s\S]*?)\n---/);
				if (!match) continue;

				const frontmatter = match[1];
				const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
				const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

				if (nameMatch) {
					agents.push({
						name: nameMatch[1].trim(),
						description: descMatch ? descMatch[1].trim() : "",
					});
				}
			} catch {
				continue;
			}
		}
		return agents;
	} catch {
		return [];
	}
}
