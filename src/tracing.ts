import { Config, Effect, Layer, Option, Tracer } from "effect";
import * as References from "effect/References";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as OtlpLogger from "effect/observability/OtlpLogger";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";

// WARNING: a child never outlasts its parent, so every exported span's parent is exported too.
export const atLeast = (inner: Tracer.Tracer, minMs: number) => {
  const minNs = BigInt(Math.round(minMs * 1_000_000));
  return Tracer.make({
    context: inner.context,
    span: (options) => {
      const span = inner.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        if (span.status._tag === "Started" && endTime - span.status.startTime < minNs)
          // WARNING: the OTLP tracer's span keeps `sampled` as a plain field and reads it at its end to decide whether to export it.
          // WARNING: the OTLP tracer keeps sampled as a plain field and reads it at span end to decide export.
          (span as { sampled: boolean }).sampled = false;
        end(endTime, exit);
      };
      return span;
    },
  });
};

export const tracingLayer = (version: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const endpoint = yield* Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"));
      if (Option.isNone(endpoint)) return Layer.succeed(References.TracerEnabled)(false);
      const minMs = yield* Config.Number("COLLIE_TRACE_MIN_MS").pipe(Config.withDefault(5));
      const resource = { serviceName: "collie-host", serviceVersion: version };
      const tracer = Layer.effect(Tracer.Tracer)(
        Effect.map(OtlpTracer.make({ url: `${endpoint.value}/v1/traces`, resource }), (inner) =>
          atLeast(inner, minMs),
        ),
      );
      const logger = OtlpLogger.layer({
        url: `${endpoint.value}/v1/logs`,
        resource,
        mergeWithExisting: true,
      });
      // WARNING: the logger's layer provides the Flusher the tracer registers with.
      return tracer.pipe(
        Layer.provideMerge(logger),
        Layer.provide([OtlpSerialization.layerJson, FetchHttpClient.layer]),
      );
    }),
  ).pipe(Layer.orDie);
