import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

interface Entry {
  name: string;
  isDir: boolean;
  isParent?: boolean;
}

interface TreeResult {
  fullPath: string;
  isDir: boolean;
}

type Mode = "browse" | "filter" | "treeSearch";

// Skipped during tree search so common dependency/VCS folders don't drown out real matches
const TREE_SEARCH_SKIP_DIRS = new Set(["node_modules", ".git"]);

let currentDir = process.cwd();
let allEntries: Entry[] = [];
let items: Entry[] = [];
let selectedIndex = 0;
let scrollOffset = 0; // vertical scroll, used by the single-column tree-search view
let columnOffset = 0; // horizontal scroll, used by the grid view
let showHidden = false;

let mode: Mode = "browse";
let queryText = "";
let treeResults: TreeResult[] = [];

// Accumulates digits typed in quick succession in browse mode (e.g. "2" then "5" -> jump to 25)
let numberBuffer = "";
let numberBufferTimer: ReturnType<typeof setTimeout> | null = null;

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdout.write("\x1B[?1049h\x1B[?25l");

function labelForEntry(e: Entry): string {
  return e.isParent ? ".." : e.name + (e.isDir ? "/" : "");
}

// Mirrors the reservedRows math in render() so keypress handlers (digit-jump, left/right)
// can compute grid geometry without re-rendering.
function getNumRows(): number {
  const rows = process.stdout.rows || 24;
  const searchBarActive = mode === "filter" || mode === "treeSearch";
  const reservedRows = 6 + (searchBarActive ? 1 : 0);
  return Math.max(1, rows - reservedRows);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = -1;
  do {
    size /= 1024;
    unitIndex++;
  } while (size >= 1024 && unitIndex < units.length - 1);
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function applyFilter() {
  if (mode === "filter" && queryText) {
    const q = queryText.toLowerCase();
    items = allEntries.filter((e) => e.isParent || e.name.toLowerCase().includes(q));
  } else {
    items = allEntries;
  }
  if (selectedIndex >= items.length) selectedIndex = Math.max(0, items.length - 1);
}

function loadDirectory(targetDir: string) {
  try {
    const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
    const visible = dirents.filter((d) => showHidden || !d.name.startsWith("."));
    const mapped: Entry[] = visible.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    mapped.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
    allEntries = [{ name: "..", isDir: true, isParent: true }, ...mapped];
  } catch {
    allEntries = [
      { name: "..", isDir: true, isParent: true },
      { name: "[Access Denied]", isDir: false },
    ];
  }
  applyFilter();
  selectedIndex = 0;
  scrollOffset = 0;
  columnOffset = 0;
}

// Bounded so searching from a shallow directory (or one containing node_modules)
// can't hang the UI while walking a huge subtree.
function searchTree(rootDir: string, query: string): TreeResult[] {
  const results: TreeResult[] = [];
  const q = query.toLowerCase();
  const maxResults = 200;
  const maxDepth = 8;
  const maxScanned = 20000;
  let scanned = 0;

  function walk(dir: string, depth: number) {
    if (results.length >= maxResults || scanned >= maxScanned || depth > maxDepth) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (results.length >= maxResults || scanned >= maxScanned) return;
      if (!showHidden && entry.name.startsWith(".")) continue;
      scanned++;
      const fullPath = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (entry.name.toLowerCase().includes(q)) {
        results.push({ fullPath, isDir });
      }
      if (isDir && !TREE_SEARCH_SKIP_DIRS.has(entry.name)) walk(fullPath, depth + 1);
    }
  }

  walk(rootDir, 0);
  return results;
}

function openFile(filePath: string) {
  // detached + unref so the spawned app doesn't tie up or block our TUI process
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", filePath], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
  }
}

function moveSelection(delta: number, length: number) {
  if (length === 0) return;
  selectedIndex = (selectedIndex + delta + length) % length;
}

function resetNumberBuffer() {
  numberBuffer = "";
  if (numberBufferTimer) {
    clearTimeout(numberBufferTimer);
    numberBufferTimer = null;
  }
}

// Appends digit to the pending buffer and jumps immediately if it resolves to a valid
// index; a stale/out-of-range buffer restarts from just the new digit (e.g. "23" then "5"
// on a 12-item view resets to "5" rather than the invalid "235").
function handleDigitInput(digit: string) {
  let candidate = numberBuffer + digit;
  let n = parseInt(candidate, 10);
  let idx = columnOffset * getNumRows() + n - 1;

  if (n === 0 || idx >= items.length) {
    candidate = digit;
    n = parseInt(candidate, 10);
    idx = columnOffset * getNumRows() + n - 1;
  }

  numberBuffer = candidate;
  if (numberBufferTimer) clearTimeout(numberBufferTimer);
  numberBufferTimer = setTimeout(resetNumberBuffer, 600);

  if (n > 0 && idx < items.length) {
    selectedIndex = idx;
    render();
  }
}

// Jump numbers go up to 99 (two digits) per view before falling back to blank -
// covers realistic grid page sizes without an unbounded/circular width calculation.
const NUMBER_WIDTH = 2;
const NUMBER_FIELD_MAX = 10 ** NUMBER_WIDTH - 1;

// One grid cell's plain (uncolored) text, fixed to cellWidth so columns line up.
// Colored separately from padding so ANSI escapes never get counted by padEnd.
function buildCell(flatIndex: number, viewStartFlatIndex: number, cellWidth: number, cellContentWidth: number): string {
  const entry = items[flatIndex];
  if (!entry) return " ".repeat(cellWidth);

  const label = labelForEntry(entry);
  const truncated = label.length > cellContentWidth ? label.slice(0, Math.max(1, cellContentWidth - 1)) + "…" : label;
  const isSelected = flatIndex === selectedIndex;
  const marker = isSelected ? ">" : " ";
  const viewPosition = flatIndex - viewStartFlatIndex;
  const numberTag =
    viewPosition >= 0 && viewPosition < NUMBER_FIELD_MAX
      ? String(viewPosition + 1).padStart(NUMBER_WIDTH, " ")
      : " ".repeat(NUMBER_WIDTH);
  const plain = ` ${marker}${numberTag} ${truncated}`.padEnd(cellWidth);

  if (isSelected) return `\x1B[7m${plain}\x1B[27m`;
  if (entry.isParent) return `\x1B[90m${plain}\x1B[39m`;
  if (entry.isDir) return `\x1B[34m${plain}\x1B[39m`;
  return plain;
}

// Fills columns top-to-bottom then left-to-right (classic `ls` grid order), so a
// plain selectedIndex +/- 1 still means "move up/down" and +/- numRows means "change column".
function renderGrid(cols: number, numRows: number) {
  const maxLabelLen = Math.max(3, ...items.map((e) => labelForEntry(e).length));
  const cellContentWidth = Math.min(maxLabelLen, 30);
  const cellWidth = cellContentWidth + NUMBER_WIDTH + 3; // ` >NN ` prefix
  const gap = 2;
  const stride = cellWidth + gap;

  const totalColumns = Math.max(1, Math.ceil(items.length / numRows));
  const maxColumnsFit = Math.max(1, Math.floor(cols / stride));

  const selectedColumn = Math.floor(selectedIndex / numRows);
  if (selectedColumn < columnOffset) {
    columnOffset = selectedColumn;
  } else if (selectedColumn >= columnOffset + maxColumnsFit) {
    columnOffset = selectedColumn - maxColumnsFit + 1;
  }
  columnOffset = Math.min(columnOffset, Math.max(0, totalColumns - maxColumnsFit));

  const visibleColumnCount = Math.min(maxColumnsFit, totalColumns - columnOffset);
  const viewStartFlatIndex = columnOffset * numRows;

  for (let r = 0; r < numRows; r++) {
    let line = "";
    for (let c = columnOffset; c < columnOffset + visibleColumnCount; c++) {
      line += buildCell(c * numRows + r, viewStartFlatIndex, cellWidth, cellContentWidth) + " ".repeat(gap);
    }
    process.stdout.write(line + "\n");
  }
}

function renderSingleColumn(
  displayList: { label: string; isDir: boolean; isParent?: boolean }[],
  cols: number,
  maxVisibleItems: number
) {
  if (selectedIndex < scrollOffset) {
    scrollOffset = selectedIndex;
  } else if (selectedIndex >= scrollOffset + maxVisibleItems) {
    scrollOffset = selectedIndex - maxVisibleItems + 1;
  }

  const visibleSubset = displayList.slice(scrollOffset, scrollOffset + maxVisibleItems);

  visibleSubset.forEach((entry, index) => {
    const actualIndex = scrollOffset + index;
    const isSelected = actualIndex === selectedIndex;
    const numberTag = index < 9 ? `${index + 1}` : " ";

    const prefix = isSelected ? ">" : " ";
    const icon = entry.isParent ? "↩ " : entry.isDir ? "📁 " : "📄 ";
    const combinedLine = ` ${prefix}${numberTag} ${icon}${entry.label}`;

    const safeLine = combinedLine.substring(0, cols).padEnd(cols, " ");

    if (isSelected) {
      process.stdout.write(`\x1B[7m${safeLine}\x1B[27m\n`);
    } else if (entry.isParent) {
      process.stdout.write(`\x1B[90m${safeLine}\x1B[39m\n`);
    } else if (entry.isDir) {
      process.stdout.write(`\x1B[34m${safeLine}\x1B[39m\n`);
    } else {
      process.stdout.write(`${safeLine}\n`);
    }
  });

  const renderedCount = visibleSubset.length;
  if (renderedCount < maxVisibleItems) {
    for (let i = 0; i < maxVisibleItems - renderedCount; i++) {
      process.stdout.write(" ".repeat(cols) + "\n");
    }
  }
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  process.stdout.write("\x1B[2J\x1B[H");

  const modeTag = mode === "filter" ? " [Filter]" : mode === "treeSearch" ? " [Find]" : "";
  const hiddenTag = showHidden ? " | Hidden: on" : "";
  const headerText = ` 📂 Bun File Explorer${modeTag}${hiddenTag} | ${cols}x${rows} | q: Exit `;
  process.stdout.write(`\x1B[7m${headerText.substring(0, cols).padEnd(cols, " ")}\x1B[27m\n`);

  const pathBanner = ` Current: ${currentDir}`;
  process.stdout.write(`\x1B[1m${pathBanner.substring(0, cols).padEnd(cols, " ")}\x1B[22m\n`);
  process.stdout.write("─".repeat(cols) + "\n");

  const searchBarActive = mode === "filter" || mode === "treeSearch";
  if (searchBarActive) {
    const label = mode === "filter" ? "Filter" : "Find in subfolders";
    const searchLine = ` ${label}: ${queryText}▌`;
    process.stdout.write(`\x1B[36m${searchLine.substring(0, cols).padEnd(cols, " ")}\x1B[39m\n`);
  }

  const maxVisibleRows = getNumRows();

  if (mode === "treeSearch") {
    const displayList = treeResults.map((r) => ({
      label: path.relative(currentDir, r.fullPath) || r.fullPath,
      isDir: r.isDir,
    }));
    renderSingleColumn(displayList, cols, maxVisibleRows);
  } else {
    renderGrid(cols, maxVisibleRows);
  }

  process.stdout.write("─".repeat(cols) + "\n");

  let infoText = "";
  const selectedEntry = mode === "treeSearch" ? undefined : items[selectedIndex];
  if (selectedEntry && !selectedEntry.isParent && selectedEntry.name !== "[Access Denied]" && !selectedEntry.isDir) {
    try {
      const st = fs.statSync(path.join(currentDir, selectedEntry.name));
      infoText = ` ${formatSize(st.size)}  ·  modified ${st.mtime.toLocaleString()}`;
    } catch {}
  }
  process.stdout.write(`\x1B[90m${infoText.substring(0, cols).padEnd(cols, " ")}\x1B[39m\n`);

  const footerText =
    mode === "browse"
      ? " ↕ Navigate | ←→ Columns | Enter Open | / Filter | f Find | ## Jump | h Hidden | q Quit"
      : " Type to search | Enter Confirm | Esc Cancel | ↕ Navigate";
  process.stdout.write(`\x1B[90m${footerText.substring(0, cols).padEnd(cols, " ")}\x1B[39m`);
}

process.stdout.on("resize", () => {
  render();
});

function exitCLI() {
  process.stdout.write("\x1B[?9l\x1B[?1049l\x1B[?25h");
  process.exit(0);
}

function enterMode(next: Mode) {
  mode = next;
  queryText = "";
  treeResults = [];
  applyFilter();
  selectedIndex = 0;
  scrollOffset = 0;
  columnOffset = 0;
}

function exitSearchMode() {
  mode = "browse";
  queryText = "";
  treeResults = [];
  applyFilter();
}

process.stdin.on("keypress", (str, key) => {
  if (key.ctrl && key.name === "c") {
    exitCLI();
    return;
  }

  if (mode === "filter" || mode === "treeSearch") {
    if (key.name === "escape") {
      exitSearchMode();
      render();
      return;
    }

    if (key.name === "return") {
      if (mode === "treeSearch") {
        const selected = treeResults[selectedIndex];
        if (selected) {
          if (selected.isDir) {
            currentDir = selected.fullPath;
            loadDirectory(currentDir);
          } else {
            currentDir = path.dirname(selected.fullPath);
            loadDirectory(currentDir);
            const idx = items.findIndex((e) => e.name === path.basename(selected.fullPath));
            if (idx >= 0) selectedIndex = idx;
          }
        }
      }
      mode = "browse";
      queryText = "";
      treeResults = [];
      render();
      return;
    }

    if (key.name === "backspace") {
      queryText = queryText.slice(0, -1);
      if (mode === "filter") applyFilter();
      else treeResults = queryText ? searchTree(currentDir, queryText) : [];
      selectedIndex = 0;
      scrollOffset = 0;
      columnOffset = 0;
      render();
      return;
    }

    if (key.name === "up") {
      moveSelection(-1, mode === "treeSearch" ? treeResults.length : items.length);
      render();
      return;
    }

    if (key.name === "down") {
      moveSelection(1, mode === "treeSearch" ? treeResults.length : items.length);
      render();
      return;
    }

    if (mode === "filter" && key.name === "left") {
      selectedIndex = Math.max(0, selectedIndex - getNumRows());
      render();
      return;
    }

    if (mode === "filter" && key.name === "right") {
      selectedIndex = Math.min(items.length - 1, selectedIndex + getNumRows());
      render();
      return;
    }

    if (str && str.length === 1 && !key.ctrl && !key.meta) {
      queryText += str;
      if (mode === "filter") applyFilter();
      else treeResults = searchTree(currentDir, queryText);
      selectedIndex = 0;
      scrollOffset = 0;
      columnOffset = 0;
      render();
      return;
    }

    return;
  }

  // browse mode
  if (key.name && /^[0-9]$/.test(key.name)) {
    handleDigitInput(key.name);
    return;
  }
  resetNumberBuffer();

  if (key.name === "q") {
    exitCLI();
    return;
  }

  if (key.name === "up") {
    moveSelection(-1, items.length);
    render();
    return;
  }

  if (key.name === "down") {
    moveSelection(1, items.length);
    render();
    return;
  }

  if (key.name === "left") {
    selectedIndex = Math.max(0, selectedIndex - getNumRows());
    render();
    return;
  }

  if (key.name === "right") {
    selectedIndex = Math.min(items.length - 1, selectedIndex + getNumRows());
    render();
    return;
  }

  if (str === "/") {
    enterMode("filter");
    render();
    return;
  }

  if (key.name === "f") {
    enterMode("treeSearch");
    render();
    return;
  }

  if (key.name === "h") {
    showHidden = !showHidden;
    loadDirectory(currentDir);
    render();
    return;
  }

  if (key.name === "return") {
    const target = items[selectedIndex];
    if (!target || target.name === "[Access Denied]") return;

    if (target.isParent) {
      currentDir = path.dirname(currentDir);
      loadDirectory(currentDir);
    } else if (target.isDir) {
      currentDir = path.join(currentDir, target.name);
      loadDirectory(currentDir);
    } else {
      openFile(path.join(currentDir, target.name));
    }
    render();
  }
});

loadDirectory(currentDir);
render();
