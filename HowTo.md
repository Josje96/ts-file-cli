# CLI Boilerplate Quickstart Guide

This guide explains how to set up and run this Bun-powered TypeScript CLI using Commander (for command-line flags) and Clack (for beautiful, interactive prompts).

## Quick Start

### 1. Install Dependencies

Bun manages TypeScript types natively. You only need to install the core libraries:

bun add @clack/prompts commander

Note: You do not need to install @types/commander or separate types. They are built-in.

### 2. Build the app (this is on you)

### 3. Run the CLI

To test your script locally with prompts, run:
bun index.ts

To skip the interactive name prompt by passing a flag, run:
bun index.ts --name "Alex"

---

## Advanced: Create a Global System Command

If you want to run this CLI from anywhere on your machine using a custom keyword (like my-cli), follow these two steps:

1. Add a shebang to the very top line of your index.ts:
#!/usr/bin/env bun

2. Link it globally using Bun:
bun link

- For windows make sure that the package json has a bin field example below

```Json

    {
      "name": "my-cli",
      "version": "1.0.0",
      "module": "index.ts",
      "type": "module",
      "bin": {
        "my-cli": "./index.ts"
      },
      "dependencies": {
        "@clack/prompts": "^0.9.0",
        "commander": "^12.0.0"
      }
    }

```

- and run bun link

---
