import { describe, expect, it } from 'vitest';
import { encodeQr } from '../src/qr.ts';

/**
 * Reference matrix for "https://example.com/yoink" (byte mode, level M,
 * version 2, mask 2), produced by the independent `qrcode` npm package.
 */
const GOLDEN = [
  '#######..#...#..#.#######',
  '#.....#...#..####.#.....#',
  '#.###.#.#...#.#...#.###.#',
  '#.###.#.##...###..#.###.#',
  '#.###.#.##...#..#.#.###.#',
  '#.....#.##.#..##..#.....#',
  '#######.#.#.#.#.#.#######',
  '........###.#.#.#........',
  '#.#####..#.###....#####..',
  '..#..#.#.###.#...#.#...#.',
  '#.##.##...#..####..#.#.##',
  '##.###..#..##.###.##....#',
  '#.##.##..#.#####.##.#.###',
  '######.......##.#..#.#.#.',
  '#.###.##.#.##..#..####.##',
  '#..#.#...#.#..#######...#',
  '#.##..#.##.####.#####.#..',
  '........#.#.##.##...##...',
  '#######..#...##.#.#.#.###',
  '#.....#.#..##.#.#...##.##',
  '#.###.#.#..##########.#..',
  '#.###.#.##.#.#.#.##.#####',
  '#.###.#.##..#..#.....##.#',
  '#.....#...##..#.##.###..#',
  '#######.##.####..########',
];

const asRows = (modules: boolean[][]) => modules.map((row) => row.map((m) => (m ? '#' : '.')).join(''));

describe('encodeQr', () => {
  it('matches the reference matrix', () => {
    const qr = encodeQr('https://example.com/yoink');
    expect(qr.version).toBe(2);
    expect(qr.mask).toBe(2);
    expect(asRows(qr.modules)).toEqual(GOLDEN);
  });

  it('picks the smallest version and keeps the finder patterns intact', () => {
    const cases: [number, number][] = [
      [14, 1], // version 1-M holds 14 bytes
      [15, 2],
      [213, 10], // 10-M holds 213 bytes (16-bit length from version 10 on)
      [2331, 40],
    ];
    for (const [length, version] of cases) {
      const qr = encodeQr('a'.repeat(length));
      expect(qr.version, `length ${length}`).toBe(version);
      expect(qr.size).toBe(version * 4 + 17);
      const rows = asRows(qr.modules);
      for (const [x, y] of [
        [0, 0],
        [qr.size - 7, 0],
        [0, qr.size - 7],
      ] as const) {
        expect(rows[y]!.slice(x, x + 7)).toBe('#######');
        expect(rows[y + 2]!.slice(x, x + 7)).toBe('#.###.#');
        expect(rows[y + 6]!.slice(x, x + 7)).toBe('#######');
      }
    }
  });

  it('throws when the data does not fit', () => {
    expect(() => encodeQr('a'.repeat(2332))).toThrow(RangeError);
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(encodeQr('ü'.repeat(7)).version).toBe(1); // 14 bytes
    expect(encodeQr('ü'.repeat(8)).version).toBe(2); // 16 bytes
  });
});
