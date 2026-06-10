import { describe, expect, it } from "vitest";

import { FillerPicker, type PickerTrack } from "./FillerPicker";

/** Deterministic RNG that replays a fixed sequence (throws if over-consumed — catches drift). */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error(`rng over-consumed at ${i}`);
    return values[i++];
  };
}

const A: PickerTrack[] = [
  { id: "a1", genre: "a" },
  { id: "a2", genre: "a" },
  { id: "a3", genre: "a" },
];
const B: PickerTrack[] = [
  { id: "b1", genre: "b" },
  { id: "b2", genre: "b" },
  { id: "b3", genre: "b" },
];

describe("FillerPicker", () => {
  it("walks genres deterministically: stay, then drift along the ring", () => {
    // ring = ["a","b"]; consumption per pick: [stay-vs-drift, (direction if drift), index].
    const rng = seqRng([
      0.1, 0.0, // pick1: 0.1<0.7 stay in "a"; index 0 -> a1
      0.9, 0.8, 0.5, // pick2: 0.9>=0.7 drift; 0.8>=0.5 -> +1 -> "b"; index floor(0.5*3)=1 -> b2
      0.9, 0.1, 0.99, // pick3: drift; 0.1<0.5 -> -1 -> back to "a"; index floor(0.99*3)=2 -> a3
    ]);
    const picker = new FillerPicker([...A, ...B], ["a", "b"], { rng, stayProbability: 0.7, recentWindow: 0 });

    const p1 = picker.pickNext();
    const p2 = picker.pickNext();
    const p3 = picker.pickNext();
    expect([p1?.genre, p2?.genre, p3?.genre]).toEqual(["a", "b", "a"]);
    expect([p1?.id, p2?.id, p3?.id]).toEqual(["a1", "b2", "a3"]);
  });

  it("never repeats a track within the recent window", () => {
    // Single genre (ring length 1 -> no genre rng), index always 0; recent filtering rotates picks.
    const picker = new FillerPicker(
      [
        { id: "a1", genre: "a" },
        { id: "a2", genre: "a" },
        { id: "a3", genre: "a" },
        { id: "a4", genre: "a" },
      ],
      ["a"],
      { rng: () => 0, recentWindow: 3 },
    );
    const ids = [picker.pickNext(), picker.pickNext(), picker.pickNext(), picker.pickNext()].map((p) => p?.id);
    expect(new Set(ids).size).toBe(4); // all four distinct -> no repeat within the window
  });

  it("orders the genre ring: requested order first, then remaining genres sorted", () => {
    const picker = new FillerPicker(
      [
        { id: "x", genre: "c" },
        { id: "y", genre: "a" },
        { id: "z", genre: "b" },
      ],
      ["b"],
    );
    expect(picker.genres).toEqual(["b", "a", "c"]);
  });

  it("returns null for an empty library", () => {
    expect(new FillerPicker([], []).pickNext()).toBeNull();
  });

  it("with a single track keeps returning it (recent window cannot starve it)", () => {
    const picker = new FillerPicker([{ id: "solo", genre: "a" }], ["a"], { rng: () => 0 });
    expect(picker.pickNext()?.id).toBe("solo");
    expect(picker.pickNext()?.id).toBe("solo");
  });
});
