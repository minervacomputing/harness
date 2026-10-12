// SHA-256 (FIPS 180-4) computed synchronously, for a folder version's digest, which is recorded in the same
// synchronous stretch as the version (a Durable Object transaction cannot await WebCrypto's promise). Only
// digests use it; content hashes are R2's and the uploads' DigestStream.

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
	0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
	0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
	0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
	0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
	0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Lowercase hex SHA-256 of the bytes. */
export function sha256HexSync(data: Uint8Array): string {
	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const w = new Uint32Array(64);
	const length = data.length;
	// The message, a 1 bit, zeros, and the length in bits as 64 bits big-endian, in whole 64-byte blocks.
	const padded = new Uint8Array((Math.floor((length + 8) / 64) + 1) * 64);
	padded.set(data);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
	view.setUint32(padded.length - 4, (length * 8) % 2 ** 32);
	for (let block = 0; block < padded.length; block += 64) {
		for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4);
		for (let t = 16; t < 64; t++) {
			const a = w[t - 15] as number;
			const b = w[t - 2] as number;
			const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
			const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
			w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
		}
		let a = h[0] as number;
		let b = h[1] as number;
		let c = h[2] as number;
		let d = h[3] as number;
		let e = h[4] as number;
		let f = h[5] as number;
		let g = h[6] as number;
		let k = h[7] as number;
		for (let t = 0; t < 64; t++) {
			const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const choose = (e & f) ^ (~e & g);
			const t1 = (k + s1 + choose + (K[t] as number) + (w[t] as number)) >>> 0;
			const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (s0 + majority) >>> 0;
			k = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		h[0] = ((h[0] as number) + a) >>> 0;
		h[1] = ((h[1] as number) + b) >>> 0;
		h[2] = ((h[2] as number) + c) >>> 0;
		h[3] = ((h[3] as number) + d) >>> 0;
		h[4] = ((h[4] as number) + e) >>> 0;
		h[5] = ((h[5] as number) + f) >>> 0;
		h[6] = ((h[6] as number) + g) >>> 0;
		h[7] = ((h[7] as number) + k) >>> 0;
	}
	let out = "";
	for (const word of h) out += word.toString(16).padStart(8, "0");
	return out;
}
