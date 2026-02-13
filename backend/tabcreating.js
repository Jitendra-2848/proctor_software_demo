// tabcreating.js - Create multiple fake students (like opening multiple tabs)
import { spawn } from "child_process";

const SERVER = process.env.SERVER || "http://localhost:3000";
const ROOM = process.argv[2] || "room1";
const COUNT = parseInt(process.argv[3] || "5");
const DELAY = parseInt(process.argv[4] || "2000"); // delay between bots in ms

console.log("╔════════════════════════════════════════════╗");
console.log("║        FAKE STUDENT BOT CREATOR           ║");
console.log("╠════════════════════════════════════════════╣");
console.log(`║  Server: ${SERVER.padEnd(34)}║`);
console.log(`║  Room:   ${ROOM.padEnd(34)}║`);
console.log(`║  Count:  ${String(COUNT).padEnd(34)}║`);
console.log(`║  Delay:  ${(DELAY + "ms").padEnd(34)}║`);
console.log("╚════════════════════════════════════════════╝\n");

const bots = [];

// Create bots one by one
async function createBot(index) {
  return new Promise((resolve) => {
    console.log(`Creating bot-${index}...`);
    
    const bot = spawn("node", [
      "script.js",
      SERVER,
      ROOM,
      `bot-${index}`
    ], {
      stdio: "inherit", // show bot output
      detached: false
    });

    bot.on("error", (err) => {
      console.error(`Bot-${index} error:`, err.message);
    });

    bot.on("close", (code) => {
      console.log(`Bot-${index} exited with code ${code}`);
    });

    bots.push(bot);
    
    setTimeout(() => resolve(), DELAY);
  });
}

// Create all bots
async function main() {
  for (let i = 0; i < COUNT; i++) {
    await createBot(i);
  }
  
  console.log(`\n✅ Created ${COUNT} bots`);
  console.log("Press Ctrl+C to stop all bots\n");
}

// Stop all bots on exit
process.on("SIGINT", () => {
  console.log("\n🛑 Stopping all bots...");
  bots.forEach(bot => {
    try {
      bot.kill("SIGINT");
    } catch (e) {}
  });
  setTimeout(() => process.exit(0), 1000);
});

main();