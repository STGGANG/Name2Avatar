// ST's public extension prompt API: IN_CHAT=1, SYSTEM=0, depth zero.
// Keep a unique slot so toggling never overwrites another extension's prompt.
export function syncDialoguePrompt(context, settings) {
  if(typeof context.setExtensionPrompt!=='function')return false;
  const text=settings.enabled && settings.dialoguePromptEnabled ? settings.dialoguePrompt.trim() : '';
  context.setExtensionPrompt('name2avatar_dialogue_format',text,1,0,false,0);
  return true;
}
