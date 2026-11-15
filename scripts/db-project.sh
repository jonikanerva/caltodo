# shellcheck shell=bash
# The caltodo settings of scripts/db.sh (STACK.md §1). scripts/db.sh is the
# same file in caltodo, mastofeed, and spot-price; the differences of this
# project are here.

DB_PROJECT=caltodo
DB_ENV=CALTODO
DB_DEV_DATABASE=caltodo
DB_TEST_DATABASE=caltodo_test
# Host ports 20000-29999. mastofeed uses 30000-39999 and spot-price
# 40000-48999. All stay below the macOS ephemeral range (49152-65535).
DB_PORT_MIN=20000
DB_PORT_SPAN=10000
DB_TLS=0
DB_PROJECT_COMMANDS=""
