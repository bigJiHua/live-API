const { scrubWithCitations } = require('../../src/modules/ai/service/webSearchCitations');
const { createEgressPolicy } = require('../../src/modules/ai/service/egressPolicy');
const URL = 'https://news.example.com/article';
const egress = () => createEgressPolicy({ userId: 'private-user-id', extraSecrets: ['site-search-test-key'] });

describe('per-turn web source citations under strict egress', () => {
  test('unconfigured/empty source path calls original scrub with identical text', () => {
    const scrub = jest.fn(text => text + 'scrubbed'), text = '消息 ' + URL;
    expect(scrubWithCitations(text, scrub, [])).toBe(text + 'scrubbed');
    expect(scrub).toHaveBeenCalledWith(text);
    expect(scrub).toHaveBeenCalledTimes(1);
  });
  test('only successful caller-approved exact sources survive, while all prose stays scrubbed', () => {
    const policy = egress(), text = `private-user-id 电话13800138000 site-search-test-key 账本100元\n来源：\n${URL}\nhttps://other.example.com/article`;
    const result = scrubWithCitations(text, policy.scrub, [{ url: URL }]);
    expect(result).toContain(URL); expect(result).toContain('账本100元');
    expect(result).not.toMatch(/private-user-id|13800138000|site-search-test-key|other\.example/);
    expect(result).toContain('[链接已隐藏]');
  });
  test('Markdown links and angle autolinks preserve just their exact destination', () => {
    const policy = egress();
    const text = `[来源](${URL})\n<${URL}>\n"${URL}"`;
    expect(scrubWithCitations(text, policy.scrub, [URL])).toBe(text);
  });
  test('Chinese/English source labels are valid URL boundaries', () => {
    const policy = egress(), text = `来源：${URL}\nSource:${URL}`;
    expect(scrubWithCitations(text, policy.scrub, [URL])).toBe(text);
  });
  test.each(['/other', '?token=secret', '#fragment', '.evil', '_suffix', ')evil', '%2Fother'])('approved URL prefix cannot approve malicious suffix %s', suffix => {
    const policy = egress(), text = `${URL}${suffix}`;
    expect(scrubWithCitations(text, policy.scrub, [URL])).toBe(policy.scrub(text));
    expect(scrubWithCitations(text, policy.scrub, [URL])).not.toContain(URL);
  });
  test('substrings inside another URL or an unseparated prefix cannot become citations', () => {
    const policy = egress();
    for (const text of [`https://evil.example.com/${URL}`, `prefix${URL}`, `https://evil.example.com?url=${URL}`]) {
      expect(scrubWithCitations(text, policy.scrub, [URL])).toBe(policy.scrub(text));
    }
  });
  test('user-supplied placeholder text never expands into a link', () => {
    const policy = egress(), fake = '@@WEBCITATION_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0@@';
    const text = fake + '\n' + URL + '\n@@WEBCITATION_any_token_1@@';
    const result = scrubWithCitations(text, policy.scrub, [URL]);
    expect(result).toContain(fake); expect(result).toContain('@@WEBCITATION_any_token_1@@');
    expect(result.split(URL)).toHaveLength(2);
  });
  test('unsafe source lists cannot weaken original URL scrub', () => {
    const policy = egress();
    for (const url of ['http://example.com', 'https://user:password@example.com', 'https://127.0.0.1/admin', `${URL}?secret=key`, `${URL}#fragment`]) {
      expect(scrubWithCitations(url, policy.scrub, [url])).toBe(policy.scrub(url));
    }
  });
  test('opaque references cannot be whitelisted even when real chat egress knows them', () => {
    const policy = egress(), ref = policy.project({ id: 'private-account-id' }, 'card').id;
    expect(policy.scrub(ref)).toBe(ref);
    for (const path of [ref, '%72' + ref.slice(1), '%2572' + ref.slice(1), '%25252572' + ref.slice(1), 'h_' + 'c'.repeat(32)]) {
      const url = `https://example.com/${path}`;
      expect(scrubWithCitations(url, policy.scrub, [url])).not.toContain('https://example.com');
    }
  });
  test('URL approval does not exempt private text inside link labels', () => {
    const policy = egress(), text = `[private-user-id 电话13800138000](${URL})`;
    const result = scrubWithCitations(text, policy.scrub, [URL]);
    expect(result).toContain(URL); expect(result).not.toMatch(/private-user-id|13800138000/);
  });
});
