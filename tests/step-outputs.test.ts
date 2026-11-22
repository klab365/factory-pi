import { expect, test } from "bun:test";
import { mapOutputs, validateOutputs } from "../src/step-outputs";

test("maps typed agent results without coercion", () => {
  const step = {
    outputs: {
      count: { type: "number", from: "result.data.count" },
      file: { type: "artifact", from: "result.path" },
    },
  };
  expect(mapOutputs(step, { data: { count: 3 }, path: "dist/report.json" })).toEqual({
    count: 3,
    file: "dist/report.json",
  });
  expect(() => mapOutputs(step, { data: { count: "3" } })).toThrow("must be number");
  expect(() => mapOutputs(step, {})).toThrow("Missing value");
  expect(() => mapOutputs(step, { data: { count: 3 }, path: "../secret" })).toThrow("relative artifact path");
});

test("validates mappings and references before execution", () => {
  expect(() =>
    validateOutputs([{ id: "a", shell: "true", outputs: { n: { type: "number", from: "result.stdout" } } }]),
  ).toThrow("unavailable");
  expect(() =>
    validateOutputs([
      {
        id: "a",
        shell: { command: "true", outputs: { stdout: true } },
        outputs: { n: { type: "number", from: "result.stdout" } },
      },
    ]),
  ).toThrow("type does not match");
  expect(() => validateOutputs([{ id: "a", shell: `echo \${{ steps.missing.outputs.x }}` }])).toThrow(
    "Unknown step output",
  );
});

test("maps boolean values and rejects non-finite, oversized, and unsafe artifact values", () => {
  expect(mapOutputs({ outputs: { ok: { type: "boolean", from: "result.ok" } } }, { ok: false })).toEqual({
    ok: false,
  });
  for (const value of [NaN, Infinity, "1", null]) {
    expect(() => mapOutputs({ outputs: { n: { type: "number", from: "result.n" } } }, { n: value })).toThrow(
      "must be number",
    );
  }
  expect(() =>
    mapOutputs({ outputs: { text: { type: "string", from: "result.text" } } }, { text: "é".repeat(32768) }),
  ).toThrow("exceeds output limit");
  for (const path of ["/tmp/file", "C:\\secret", "..\\secret", "a/../secret", "\0", ""]) {
    expect(() =>
      mapOutputs({ outputs: { file: { type: "artifact", from: "result.path" } } }, { path }),
    ).toThrow("relative artifact path");
  }
});

test("output names do not mutate the output object's prototype", () => {
  const step = JSON.parse('{"outputs":{"__proto__":{"type":"string","from":"result.value"}}}');
  const mapped = mapOutputs(step, { value: "safe" });
  expect(Object.hasOwn(mapped, "__proto__")).toBe(true);
  expect(Reflect.get(mapped, "__proto__")).toBe("safe");
  expect(Object.getPrototypeOf(mapped)).toBe(Object.prototype);
});

test("rejects forward, self, and bypassed output references before execution", () => {
  const producer = {
    id: "produce",
    shell: "true",
    outputs: { code: { type: "number", from: "result.exitCode" } },
  };
  const consumer = { id: "consume", shell: `echo \${{ steps.produce.outputs.code }}` };
  expect(() => validateOutputs([consumer, producer])).toThrow("not available on every path");
  expect(() => validateOutputs([{ ...producer, shell: consumer.shell }])).toThrow("not available");
  expect(() =>
    validateOutputs([
      { id: "choose", shell: "true", transitions: { completed: "produce", skipped: "consume" } },
      producer,
      consumer,
    ]),
  ).toThrow("not available on every path");
  expect(() => validateOutputs([producer, consumer])).not.toThrow();
  expect(() =>
    validateOutputs([producer, { ...consumer, transitions: { completed: "produce" } }]),
  ).not.toThrow();
});

test("rejects malformed definitions and output expressions", () => {
  for (const definition of [
    { type: "object", from: "result.data" },
    { type: "string", from: "env.SECRET" },
    { type: "string", from: "result.data", extra: true },
  ]) {
    expect(() => validateOutputs([{ id: "work", shell: "true", outputs: { data: definition } }])).toThrow();
  }
  expect(() =>
    validateOutputs([{ id: "work", shell: `echo \${{ steps.work.outputs.data || env.SECRET }}` }]),
  ).toThrow("Invalid step output expression");
});

test.each(["outputs", "outputs-dir", "outputsDirectory"])(
  "accepts input reference '%s' without treating it as a step output",
  (name) => {
    expect(() => validateOutputs([{ id: "work", shell: `echo \${{ inputs.${name} }}` }])).not.toThrow();
  },
);

test.each(["steps.work.outputs", "steps.work.outputs[0]", "steps.work.outputs.data || env.SECRET"])(
  "rejects malformed step-output expression '%s'",
  (expression) => {
    expect(() => validateOutputs([{ id: "work", shell: `echo \${{ ${expression} }}` }])).toThrow(
      "Invalid step output expression",
    );
  },
);
