import { describe, expect, it } from "vitest";

import { selectRecording, type AcoustIdResult } from "./MusicTagger";

// Real AcoustID responses captured from the two mis-tagged songs (artists verbatim, incl. the
// U+2010 hyphen MusicBrainz uses in "blink‐182"). The original recurs across results and is named
// in the source title; the cover (Jedward / Walt Ribeiro) appears once and isn't in the title.
const BLINK: AcoustIdResult[] = [
  {
    score: 0.978,
    recordings: [
      { title: "All the Small Things", artists: [{ name: "Jedward" }] },
      { title: "All the Small Things", artists: [{ name: "blink‐182" }] },
      { title: "True to Me", artists: [{ name: "Metro Station" }] },
      { title: "All the Small Things", artists: [{ name: "blink‐182" }] },
    ],
  },
  { score: 0.967, recordings: [{ title: "All the Small Things", artists: [{ name: "blink‐182" }] }] },
  {
    score: 0.96,
    recordings: [
      { title: "The Ballad of John and Yoko", artists: [{ name: "The Beatles" }] },
      { title: "All the Small Things", artists: [{ name: "The Countdown Singers" }] },
      { title: "All the Small Things", artists: [{ name: "blink‐182" }] },
    ],
  },
];

const DAFT: AcoustIdResult[] = [
  {
    score: 0.992,
    recordings: [
      { title: "Daft Punk ‘Aerodynamic’", artists: [{ name: "Walt Ribeiro" }] },
      { title: "Aerodynamic", artists: [{ name: "Daft Punk" }] },
      { title: "Aerodynamic", artists: [{ name: "Daft Punk" }] },
      { title: "Aerodynamic Beats / Forget About the World", artists: [{ name: "Daft Punk" }, { name: "Gabrielle" }] },
    ],
  },
  { score: 0.96, recordings: [{ title: "Aerodynamic", artists: [{ name: "Daft Punk" }] }] },
  {
    score: 0.93,
    recordings: [
      { title: "Aerodynamic", artists: [{ name: "Daft Punk" }] },
      { title: "Baby Pluto", artists: [{ name: "Lil Uzi Vert" }] },
    ],
  },
];

describe("selectRecording", () => {
  it("picks blink-182 over the Jedward cover when the title names the artist", () => {
    const picked = selectRecording(BLINK, "blink-182 - All The Small Things", 0.5);
    expect(picked?.artist).toMatch(/blink/i);
    expect(picked?.artist).not.toMatch(/jedward/i);
    expect(picked?.title).toMatch(/all the small things/i);
  });

  it("picks Daft Punk over the Walt Ribeiro cover, with the clean title", () => {
    const picked = selectRecording(DAFT, "Daft Punk - Aerodynamic", 0.5);
    expect(picked?.artist).toMatch(/daft punk/i);
    expect(picked?.artist).not.toMatch(/ribeiro/i);
    expect(picked?.title).toBe("Aerodynamic");
  });

  it("still picks the original via consensus when the source title lacks the artist", () => {
    expect(selectRecording(BLINK, "All The Small Things", 0.5)?.artist).toMatch(/blink/i);
    expect(selectRecording(DAFT, "Aerodynamic", 0.5)?.artist).toMatch(/daft punk/i);
  });

  it("returns null when nothing clears the score threshold", () => {
    expect(selectRecording([{ score: 0.2, recordings: [{ title: "x", artists: [{ name: "y" }] }] }], "x", 0.5)).toBeNull();
    expect(selectRecording([], "x", 0.5)).toBeNull();
  });
});
