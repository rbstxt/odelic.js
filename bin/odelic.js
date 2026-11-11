#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main();
// noble keeps native handles open after use, so exit explicitly (null = long-running, e.g. `odelic mcp`)
if (code !== null) process.exit(code);
