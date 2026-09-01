let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  if (source === "hang") {
    setInterval(() => {}, 60_000);
    return;
  }
  if (source.startsWith("exit:")) {
    process.stderr.write(`runner failed: ${source}\n`);
    process.exit(Number(source.slice(5)) || 1);
  }
  if (source === "signal") {
    process.kill(process.pid, "SIGTERM");
    return;
  }
  if (source.startsWith("bytes:")) {
    process.stdout.write("x".repeat(Number(source.slice(6)) || 0));
    return;
  }
  process.stdout.write(`ran:${source}`);
});
