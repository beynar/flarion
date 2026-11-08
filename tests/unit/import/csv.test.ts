import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, readRecords, stripBom, utf8Length } from '../../../src/lib/shared/import/csv';

describe('csv reader', () => {
	it('reads plain records with every line ending', () => {
		expect(parseCsv('a,b\n1,2\n').records).toEqual([['a', 'b'], ['1', '2']]);
		expect(parseCsv('a,b\r\n1,2\r\n').records).toEqual([['a', 'b'], ['1', '2']]);
		expect(parseCsv('a,b\r1,2\r').records).toEqual([['a', 'b'], ['1', '2']]);
		expect(parseCsv('a,b\n1,2').records).toEqual([['a', 'b'], ['1', '2']]);
	});

	it('reads quoted fields: delimiters, doubled quotes and newlines inside', () => {
		const text = 'name,note\n"Smith, Jo","said ""hi"""\n"two\nlines","a\r\nb"\n';
		expect(parseCsv(text).records).toEqual([
			['name', 'note'],
			['Smith, Jo', 'said "hi"'],
			['two\nlines', 'a\r\nb']
		]);
	});

	it('keeps empty fields, trailing delimiters and quoted empties', () => {
		expect(parseCsv('a,b,c\n,,\n1,,3\n"","x",\n').records).toEqual([['a', 'b', 'c'], ['', '', ''], ['1', '', '3'], ['', 'x', '']]);
	});

	it('skips blank lines', () => {
		expect(parseCsv('a,b\n\n1,2\n\r\n\n3,4\n\n').records).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
	});

	it('is lenient with a stray quote and an unterminated quote', () => {
		expect(parseCsv('a,b\n5" tall,x\n').records).toEqual([['a', 'b'], ['5" tall', 'x']]);
		expect(parseCsv('a,b\n"abc"def,x\n').records[1]).toEqual(['abcdef', 'x']);
		expect(parseCsv('a,b\n1,"never closed\nstill').records[1]).toEqual(['1', 'never closed\nstill']);
	});

	it('strips a byte order mark', () => {
		expect(stripBom('﻿a,b')).toBe('a,b');
		expect(parseCsv('﻿name,age\nA,1\n').records[0]).toEqual(['name', 'age']);
	});

	it('detects the delimiter: comma, semicolon, tab, pipe', () => {
		expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
		expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
		expect(detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
		expect(detectDelimiter('a|b|c\n1|2|3\n')).toBe('|');
		// commas inside the data of a semicolon file do not win
		expect(detectDelimiter('name;note\nJo;"a, b, c"\nAl;"d, e"\nBo;plain, text, here\n')).toBe(';');
		// quoted delimiters do not count
		expect(detectDelimiter('a;b\n"1,2,3,4";x\n"5,6,7,8";y\n')).toBe(';');
		// one column: a comma
		expect(detectDelimiter('title\nfoo\nbar\n')).toBe(',');
		expect(parseCsv('x;y\n1;2\n').records).toEqual([['x', 'y'], ['1', '2']]);
	});

	it('resumes: complete records only until the input is final, and the end is a record boundary', () => {
		const text = 'a,b\n1,"x\ny"\n2,3';
		const part = readRecords(text, ',', { final: false });
		expect(part.records).toEqual([['a', 'b'], ['1', 'x\ny']]);
		expect(text.slice(part.end)).toBe('2,3');
		expect(readRecords(text.slice(part.end), ',', { final: true }).records).toEqual([['2', '3']]);
		// a record cut inside quotes waits
		expect(readRecords('a,"cut', ',', { final: false })).toEqual({ records: [], end: 0 });
		// a lone \r at the end may be half of \r\n
		expect(readRecords('a,b\r', ',', { final: false }).records).toEqual([]);
		expect(readRecords('a,b\r', ',', { final: true }).records).toEqual([['a', 'b']]);
	});

	it('feeding a stream in arbitrary chunks gives the same records as one read', () => {
		const rows = Array.from({ length: 60 }, (_, i) => `${i},"line ${i}\nsecond, with ""quotes""",${i % 3 === 0 ? '' : 'x'}`);
		const text = ['id,body,tag', ...rows].join('\r\n') + '\r\n';
		const expected = parseCsv(text).records;
		for (const size of [1, 2, 3, 7, 16, 50, 1000]) {
			const got: string[][] = [];
			let buffer = '';
			for (let i = 0; i < text.length; i += size) {
				buffer += text.slice(i, i + size);
				const r = readRecords(buffer, ',', { final: false });
				got.push(...r.records);
				buffer = buffer.slice(r.end);
			}
			got.push(...readRecords(buffer, ',', { final: true }).records);
			expect(got).toEqual(expected);
		}
	});

	it('honours max and reports where it stopped', () => {
		const text = 'a\nb\n\nc\nd\n';
		const r = readRecords(text, ',', { final: true, max: 2 });
		expect(r.records).toEqual([['a'], ['b']]);
		expect(readRecords(text.slice(r.end), ',', { final: true }).records).toEqual([['c'], ['d']]);
	});

	it('counts UTF-8 bytes', () => {
		for (const s of ['abc', 'é', '€', '😀', 'a😀é€']) expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
	});
});
