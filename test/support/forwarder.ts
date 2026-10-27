#!/usr/bin/env bun
// The fake herdr and fake forge as executables: a process started for every call, which
// hands its argv, working directory and environment to the test process on COLLIE_FAKE_SOCKET and prints the
// answer it gets back. No Effect, so a start costs about what a small CLI's does.

import { connect } from "node:net";

const path = process.env.COLLIE_FAKE_SOCKET ?? "";
let reply = "";

const fail = (why: string) => {
  process.stderr.write(
    `fake ${process.argv[2] ?? ""}: no test process answers on ${path}: ${why}\n`,
  );
  process.exitCode = 70;
};

const socket = connect(path);
socket.setEncoding("utf8");
socket.on("connect", () =>
  socket.end(
    `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env })}\n`,
  ),
);
socket.on("data", (chunk) => {
  reply += chunk;
});
socket.on("error", (error: NodeJS.ErrnoException) => fail(error.code ?? error.message));
socket.on("close", (hadError) => {
  if (hadError) return;
  let answer: { code: number; stdout: string; stderr: string };
  try {
    answer = JSON.parse(reply);
  } catch {
    return fail("it closed without an answer");
  }
  process.stderr.write(answer.stderr);
  process.stdout.write(answer.stdout);
  process.exitCode = answer.code;
});
