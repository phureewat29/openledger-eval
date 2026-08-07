/**
 * Environment facts the model cannot infer, and nothing else. Usage rules for
 * `oled` are deliberately absent: SKILL.md and `--help` are the surface under
 * test, so repeating their advice here would measure this text instead.
 */
const ENVIRONMENT_ADAPTER = `## This environment

- You have one tool, \`oled\`, and no filesystem: no shell operators, and no way to create or read files yourself.
- Whatever a command produces for you to read is delivered into this conversation automatically.
- Whatever a command would read from stdin goes in the tool's \`stdin\` field.
- Keep replies short. This run scores your actions, not your prose.`;

export function buildSystemPrompt(skillMd: string): string {
  return `${skillMd.trim()}\n\n${ENVIRONMENT_ADAPTER}\n`;
}
