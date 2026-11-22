#!/usr/bin/env node
/**
 * Compatibility alias: the CLI's primary name is `evalid`
 * (this file was bin/xflow.js before the rename). The legacy
 * `xflow` bin keeps working by delegating to the real entry.
 */
import './evalid.js';
