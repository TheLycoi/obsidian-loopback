/*
Ambient module declarations for asset imports esbuild handles at build time
but TypeScript otherwise has no type information for.
*/

declare module "*.md" {
	const content: string;
	export default content;
}
