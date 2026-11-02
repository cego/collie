#!/bin/sh
dir=$1
echo run >>"$dir/count"
echo $$ >>"$dir/starts"
echo out
echo err >&2
while [ ! -f "$dir/release" ]; do sleep 0.1; done
echo done
exit 3
