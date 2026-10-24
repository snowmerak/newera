import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

// Load server credentials without using Vite's public VITE_ prefix.
for (const [key, value] of Object.entries(loadEnv(process.env.NODE_ENV || 'development', process.cwd(), ['NEWERA_', 'OPENAI_API_KEY', 'XAI_API_KEY', 'X_AI_API_KEY', 'OPENROUTER_API_KEY']))) {
	if (process.env[key] === undefined) process.env[key] = value;
}

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
