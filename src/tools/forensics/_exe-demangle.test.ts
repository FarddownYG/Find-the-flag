import { describe, expect, it } from 'vitest';
import { demangle } from './_exe-demangle';

/**
 * Expected strings are the output of GNU c++filt (binutils 2.42, libiberty, verbose mode as the
 * command line tool runs it) for the same input: this demangler either agrees with it or gives up.
 */
const CPP_FILT: [string, string][] = [
  ['_ZN3foo3barEv', 'foo::bar()'],
  ['_ZN3foo3barEi', 'foo::bar(int)'],
  ['_ZNK3foo3barEv', 'foo::bar() const'],
  ['_Z3addii', 'add(int, int)'],
  ['_Z3fooPKc', 'foo(char const*)'],
  ['_Z3fooRSs', 'foo(std::basic_string<char, std::char_traits<char>, std::allocator<char> >&)'],
  ['_Z3fooPFviE', 'foo(void (*)(int))'],
  ['_Z3fooPA3_i', 'foo(int (*) [3])'],
  ['_Z3fooRA3_i', 'foo(int (&) [3])'],
  ['_ZN3FooC1Ev', 'Foo::Foo()'],
  ['_ZN3FooD0Ev', 'Foo::~Foo()'],
  ['_ZN3FooD2Ev', 'Foo::~Foo()'],
  ['_ZN3FoocviEv', 'Foo::operator int()'],
  ['_ZN3FooplERKS_', 'Foo::operator+(Foo const&)'],
  ['_ZN3FoolsERSo', 'Foo::operator<<(std::basic_ostream<char, std::char_traits<char> >&)'],
  ['_ZNSolsEi', 'std::basic_ostream<char, std::char_traits<char> >::operator<<(int)'],
  [
    '_ZStlsISt11char_traitsIcEERSt13basic_ostreamIcT_ES5_PKc',
    'std::basic_ostream<char, std::char_traits<char> >& std::operator<< <std::char_traits<char> >(std::basic_ostream<char, std::char_traits<char> >&, char const*)',
  ],
  [
    '_ZSt4endlIcSt11char_traitsIcEERSt13basic_ostreamIT_T0_ES6_',
    'std::basic_ostream<char, std::char_traits<char> >& std::endl<char, std::char_traits<char> >(std::basic_ostream<char, std::char_traits<char> >&)',
  ],
  [
    '_ZNSsC1ERKSs',
    'std::basic_string<char, std::char_traits<char>, std::allocator<char> >::basic_string(std::basic_string<char, std::char_traits<char>, std::allocator<char> > const&)',
  ],
  [
    '_ZNSt6vectorIiSaIiEE9push_backERKi',
    'std::vector<int, std::allocator<int> >::push_back(int const&)',
  ],
  [
    '_ZNSt3mapIiSsSt4lessIiESaISt4pairIKiSsEEEixERS3_',
    'std::map<int, std::basic_string<char, std::char_traits<char>, std::allocator<char> >, std::less<int>, std::allocator<std::pair<int const, std::basic_string<char, std::char_traits<char>, std::allocator<char> > > > >::operator[](int const&)',
  ],
  ['_ZN5ftf_a5ftf_bIiE3runIdEEvT_', 'void ftf_a::ftf_b<int>::run<double>(double)'],
  ['_ZTV3Foo', 'vtable for Foo'],
  ['_ZTI3Foo', 'typeinfo for Foo'],
  ['_ZTS3Foo', 'typeinfo name for Foo'],
  ['_ZGVZ4mainE1x', 'guard variable for main::x'],
  ['_ZZ4mainE1x', 'main::x'],
  ['_ZZ3foovE3bar', 'foo()::bar'],
  ['_ZThn8_N3Foo3barEv', 'non-virtual thunk to Foo::bar()'],
  [
    '_ZN9__gnu_cxx13new_allocatorIcE8allocateEmPKv',
    '__gnu_cxx::new_allocator<char>::allocate(unsigned long, void const*)',
  ],
  [
    '_ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE6appendEPKc',
    'std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >::append(char const*)',
  ],
  ['_Z1fIiEvT_', 'void f<int>(int)'],
  ['_Z1fIJidEEvDpT_', 'void f<int, double>(int, double)'],
  ['_Z3fooILi5EEvv', 'void foo<5>()'],
  ['_Z3fooILb1EEvv', 'void foo<true>()'],
  ['_ZN4llvm5ValueC1Ev', 'llvm::Value::Value()'],
  ['_ZNKSt5ctypeIcE8do_widenEc', 'std::ctype<char>::do_widen(char) const'],
  ['_ZnwmRKSt9nothrow_t', 'operator new(unsigned long, std::nothrow_t const&)'],
  ['_ZdlPvm', 'operator delete(void*, unsigned long)'],
  ['_Z3fooM3BarFivE', 'foo(int (Bar::*)())'],
  ['_Z3fooM3Bari', 'foo(int Bar::*)'],
  ['_ZN3FooB5cxx11C1Ev', 'Foo[abi:cxx11]::Foo()'],
  ['_ZZ4mainENKUlvE_clEv', 'main::{lambda()#1}::operator()() const'],
  ['_Z3foov.cold', 'foo() [clone .cold]'],
  ['_Z3fooIiEvT_.part.0', 'void foo<int>(int) [clone .part.0]'],
];

describe('demangle: agrees with c++filt', () => {
  for (const [mangled, expected] of CPP_FILT) {
    it(mangled, () => {
      expect(demangle(mangled)).toBe(expected);
    });
  }
});

describe('demangle: legacy Rust names', () => {
  it('drops the hash and unescapes the symbols', () => {
    expect(
      demangle(
        '_ZN4core3ptr85drop_in_place$LT$std..rt..lang_start$LT$$LP$$RP$$GT$..$u7b$$u7b$closure$u7d$$u7d$$GT$17h0123456789abcdefE',
      ),
    ).toBe('core::ptr::drop_in_place<std::rt::lang_start<()>::{{closure}}>');
  });
  it('needs the hash: a plain _ZN name with digits is C++', () => {
    expect(demangle('_ZN4core3fmtE')).toBe('core::fmt');
  });
});

describe('demangle: gives up instead of guessing', () => {
  it('returns null for names that are not mangled', () => {
    expect(demangle('main')).toBeNull();
    expect(demangle('_start')).toBeNull();
    expect(demangle('__libc_start_main')).toBeNull();
    expect(demangle('')).toBeNull();
    expect(demangle('_Z')).toBeNull();
  });
  it('returns null for what it does not handle (expressions, vendor types)', () => {
    expect(demangle('_Z1fIXadL_Z1gvEEEvv')).toBeNull();
    expect(demangle('_Z1fu8__vectori')).toBeNull();
  });
  it('returns null for truncated or trailing garbage', () => {
    expect(demangle('_ZN3foo3barEv_extra')).toBeNull();
    expect(demangle('_ZN3foo3ba')).toBeNull();
    expect(demangle('_ZN3foo99barEv')).toBeNull();
  });
  it('does not expand a substitution bomb', () => {
    // a<a, a>, then a<that, that>, ...: every level doubles the text (2^30 characters in all)
    let args = '1aIS_S_E';
    for (let k = 1; k < 30; k++) {
      const ref = `S${(2 * k - 1).toString(36).toUpperCase()}_`;
      args += `1aI${ref}${ref}E`;
    }
    const t0 = performance.now();
    const out = demangle(`_Z1fI${args}Evv`);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(out).toBeNull();
  });
  it('survives deep nesting', () => {
    expect(demangle(`_Z1f${'P'.repeat(5000)}i`)).toBeNull();
    expect(demangle('_Z' + 'N1a'.repeat(3000) + 'Ev')).toBeNull();
  });
});

describe('demangle: random damage never throws', () => {
  it('mutates real names', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const alphabet = '0123456789NEIKPRSTZ_abcdilvx.';
    for (let i = 0; i < 4000; i++) {
      const base = CPP_FILT[rnd(CPP_FILT.length)]![0];
      const chars = [...base];
      const edits = 1 + rnd(3);
      for (let e = 0; e < edits; e++) {
        const at = rnd(chars.length);
        const kind = rnd(3);
        if (kind === 0) chars[at] = alphabet[rnd(alphabet.length)]!;
        else if (kind === 1) chars.splice(at, 1);
        else chars.splice(at, 0, alphabet[rnd(alphabet.length)]!);
      }
      const out = demangle(chars.join(''));
      expect(out === null || typeof out === 'string').toBe(true);
    }
  });
});
