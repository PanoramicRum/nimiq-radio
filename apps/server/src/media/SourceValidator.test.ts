import { describe, expect, it } from "vitest";

import { SourceValidationError, validateSource, type Source } from "./SourceValidator";

describe("validateSource — accepted hosts", () => {
  const ok: Array<[string, string, Source]> = [
    // YouTube (rebuilt to canonical watch URL)
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    // SoundCloud — single track; query (?in=…) and credentials stripped on rebuild
    ["https://soundcloud.com/artist/some-track", "https://soundcloud.com/artist/some-track", "soundcloud"],
    ["https://m.soundcloud.com/artist/some-track", "https://soundcloud.com/artist/some-track", "soundcloud"],
    ["https://soundcloud.com/artist/some-track?in=artist/sets/x", "https://soundcloud.com/artist/some-track", "soundcloud"],
    ["https://hax@soundcloud.com/artist/some-track", "https://soundcloud.com/artist/some-track", "soundcloud"],
    // Bandcamp — single track on an artist subdomain
    ["https://myband.bandcamp.com/track/my-song", "https://myband.bandcamp.com/track/my-song", "bandcamp"],
    ["https://myband.bandcamp.com/track/my-song?foo=bar", "https://myband.bandcamp.com/track/my-song", "bandcamp"],
    // Audius — single track
    ["https://audius.co/pzl/tamale-100456", "https://audius.co/pzl/tamale-100456", "audius"],
  ];

  it.each(ok)("accepts %s", (input, canonical, source) => {
    const r = validateSource(input);
    expect(r.canonicalUrl).toBe(canonical);
    expect(r.source).toBe(source);
  });
});

describe("validateSource — rejections", () => {
  const bad: string[] = [
    "not a url",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ", // not https
    "https://evil.com/watch?v=dQw4w9WgXcQ", // host not allowed
    "https://soundcloud.com@evil.com/a/b", // @-trick: real host is evil.com
    "https://www.youtube.com/watch?v=short", // invalid 11-char id
    "https://soundcloud.com/artist/sets/my-playlist", // a set, not a track
    "https://myband.bandcamp.com/album/my-album", // album, not a track
    "https://bandcamp.com/track/x", // bare bandcamp.com host
    "https://audius.co/pzl/playlist/pzlwip-12770", // playlist, not a track
    "https://audius.co/pzl", // bare profile
  ];

  it.each(bad)("rejects %s", (input) => {
    expect(() => validateSource(input)).toThrow(SourceValidationError);
  });
});
