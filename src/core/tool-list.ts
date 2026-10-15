import type { AnyTool } from './types';

/**
 * The registered tools, for the tools that look at the others (the cipher identifier asks every
 * encoding tool whether it recognises a text). registry.ts sets the list once it has loaded every
 * tool. A tool cannot import the registry itself: the registry imports the tool.
 */
let tools: readonly AnyTool[] = [];

export const registeredTools = (): readonly AnyTool[] => tools;

export function setRegisteredTools(list: readonly AnyTool[]): void {
  tools = list;
}
