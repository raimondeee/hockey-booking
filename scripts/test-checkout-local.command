#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
exec ./scripts/test-checkout-local.sh
