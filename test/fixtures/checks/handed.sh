#!/bin/sh
# A check that counts its runs in "$1/count" and notes its pid in "$1/starts", writes to
# both streams, and exits 3 once "$1/release" exists.
dir=$1
echo run >>"$dir/count"
echo $$ >>"$dir/starts"
echo out
echo err >&2
while [ ! -f "$dir/release" ]; do sleep 0.1; done
echo done
exit 3
