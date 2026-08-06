async function(args) {
  const composer = document.querySelector(
    'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
  );
  if (!composer) return { open: false, text: '', submitLabel: '', submitEnabled: false };

  const dialog = composer.closest('div[role="dialog"]');
  const buttons = [...(dialog?.querySelectorAll('[role="button"]') || [])];
  const submit = buttons.find((el) => {
    const name = (el.getAttribute('aria-label') || el.innerText || '').trim().toLowerCase();
    return ['post', 'publish', 'közzététel', 'bejegyzés', 'küldés', 'posztolás'].includes(name);
  });

  return {
    open: true,
    text: (composer.innerText || '').trim(),
    submitLabel: (submit?.getAttribute('aria-label') || submit?.innerText || '').trim(),
    submitEnabled: Boolean(submit) && submit.getAttribute('aria-disabled') !== 'true',
  };
}
