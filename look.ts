import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// Track application tracking state
let currentDir = process.cwd();
let items: string[] = [];
let selectedIndex = 0;
let scrollOffset = 0;

// Setup terminal input mapping
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

// Enter alternate screen buffer & hide native cursor
process.stdout.write("\x1B[?1049h\x1B[?25l");

function loadDirectory(targetDir: string) {
  try {
    const rawItems = fs.readdirSync(targetDir);
    // Sort directory layouts: folders first, then files
    items = ["..", ...rawItems].sort((a, b) => {
      if (a === "..") return -1;
      if (b === "..") return 1;
      const aStat = fs.statSync(path.join(targetDir, a));
      const bStat = fs.statSync(path.join(targetDir, b));
      if (aStat.isDirectory() && !bStat.isDirectory()) return -1;
      if (!aStat.isDirectory() && bStat.isDirectory()) return 1;
      return a.localeCompare(b);
    });
    selectedIndex = 0;
    scrollOffset = 0;
  } catch (err) {
    // Graceful fallback if access to specific directory is denied
    items = ["..", "[Access Denied]"];
    selectedIndex = 0;
  }
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Clear current viewport matrix without leaving historical screen debris
  process.stdout.write("\x1B[2J\x1B[H");

  // Header Banner Allocation (Consumes 3 rows total)
  const headerText = ` 📂 Bun File Explorer | ${cols}x${rows} | q: Exit `;
  const truncatedHeader = headerText.substring(0, cols).padEnd(cols, " ");
  process.stdout.write(`\x1B[7m${truncatedHeader}\x1B[27m\n`);
  
  const pathBanner = ` Current: ${currentDir}`;
  process.stdout.write(`\x1B[1m${pathBanner.substring(0, cols).padEnd(cols, " ")}\x1B[22m\n`);
  process.stdout.write("─".repeat(cols) + "\n");

  // Dynamic Row Budget Calculations
  const reservedRows = 5; // Header (3) + Footer Divider (1) + Instructions Footer (1)
  const maxVisibleItems = Math.max(1, rows - reservedRows);

  // Keep selection bracket clamped neatly on-screen
  if (selectedIndex < scrollOffset) {
    scrollOffset = selectedIndex;
  } else if (selectedIndex >= scrollOffset + maxVisibleItems) {
    scrollOffset = selectedIndex - maxVisibleItems + 1;
  }

  // Draw active scoped items subset
  const visibleSubset = items.slice(scrollOffset, scrollOffset + maxVisibleItems);
  
  visibleSubset.forEach((item, index) => {
    const actualIndex = scrollOffset + index;
    const isSelected = actualIndex === selectedIndex;
    
    let isDir = false;
    try {
      if (item !== "..") {
        isDir = fs.statSync(path.join(currentDir, item)).isDirectory();
      }
    } catch {}

    const prefix = isSelected ? " > " : "   ";
    const icon = item === ".." ? "↩ " : isDir ? "📁 " : "📄 ";
    const combinedLine = `${prefix}${icon}${item}`;
    
    // Hard string clipping ensuring strings never wrap onto secondary terminal lines
    const safeLine = combinedLine.substring(0, cols).padEnd(cols, " ");

    if (isSelected) {
      // Invert color terminal block for active selection
      process.stdout.write(`\x1B[7m${safeLine}\x1B[27m\n`);
    } else if (item === "..") {
      process.stdout.write(`\x1B[90m${safeLine}\x1B[39m\n`); // Dim parent link
    } else if (isDir) {
      process.stdout.write(`\x1B[34m${safeLine}\x1B[39m\n`); // Blue folders
    } else {
      process.stdout.write(`${safeLine}\n`);
    }
  });

  // Pad out remaining structural space if viewing an empty folder
  const renderedCount = visibleSubset.length;
  if (renderedCount < maxVisibleItems) {
    for (let i = 0; i < maxVisibleItems - renderedCount; i++) {
      process.stdout.write(" ".repeat(cols) + "\n");
    }
  }

  // Draw Context Footer Line
  process.stdout.write("─".repeat(cols) + "\n");
  const footerText = " ↕: Navigate | Enter: Open / Action | q: Quit";
  process.stdout.write(`\x1B[90m${footerText.substring(0, cols).padEnd(cols, " ")}\x1B[39m`);
}

// 🔄 Bind Core Resize Interceptor Engine
process.stdout.on("resize", () => {
  render();
});

// Exit Cleanup Sequence: restores terminal alternate buffer context and text cursor
function exitCLI() {
  process.stdout.write("\x1B[?9l\x1B[?1049l\x1B[?25h");
  process.exit(0);
}

// 🔑 Input Router Logic Loop
process.stdin.on("keypress", (str, key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    exitCLI();
  }

  if (key.name === "up") {
    selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : items.length - 1;
    render();
  }
  
  if (key.name === "down") {
    selectedIndex = selectedIndex < items.length - 1 ? selectedIndex + 1 : 0;
    render();
  }

  if (key.name === "return") {
    const targetItem = items[selectedIndex];
    if (!targetItem || targetItem === "[Access Denied]") return;

    const targetPath = targetItem === ".." 
      ? path.dirname(currentDir) 
      : path.join(currentDir, targetItem);

    try {
      const stats = fs.statSync(targetPath);
      if (stats.isDirectory()) {
        currentDir = targetPath;
        loadDirectory(currentDir);
        render();
      } else {
        // Run specific custom actions against target files
        // E.g., open in editor or stream details:
        // process.stdout.write(`Opening ${targetItem}...`);
      }
    } catch {}
  }
});

// Launch Initial Instance State
loadDirectory(currentDir);
render();