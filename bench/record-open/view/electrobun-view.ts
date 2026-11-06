// Electrobun's view API as the benchmark's view gets it: RPC frames over a WebSocket to the
// page's own server.

import type { FrameSchema } from "../../../desktop/src/shared/channel";

type Frame = FrameSchema["messages"]["frame"];
interface Rpc {
  readonly handlers: { readonly messages: { readonly frame: (frame: Frame) => void } };
}

export type RPCSchema<T> = T;

export class Electroview {
  static defineRPC = <S>(rpc: Rpc & S) => rpc;
  readonly rpc: { send: { frame: (frame: Frame) => void } };
  constructor({ rpc }: { rpc: Rpc }) {
    const socket = new WebSocket(`ws://${location.host}/frames`);
    const waiting: string[] = [];
    socket.onopen = () => {
      for (const frame of waiting.splice(0)) socket.send(frame);
    };
    socket.onmessage = (event) => rpc.handlers.messages.frame(JSON.parse(String(event.data)));
    this.rpc = {
      send: {
        frame: (frame) => {
          const text = JSON.stringify(frame);
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
          else waiting.push(text);
        },
      },
    };
  }
}
