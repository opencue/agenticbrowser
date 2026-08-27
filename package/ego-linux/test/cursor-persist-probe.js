const state = await page.evaluate(`(() => {
  const host = document.getElementById('ego-agent-cursor-overlay');
  return JSON.stringify({
    present: !!host,
    visible: !!host && host.style.opacity === '1' && !host.__egoLeaving,
    label: host?.__egoShadow?.getElementById('text')?.textContent || '',
  });
})()`);

console.log("AFTER RECONNECT: " + state);
