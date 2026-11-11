#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main(['mcp']);
if (code !== null) process.exit(code);
