use std::collections::HashMap;

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use macro_transformer_native::transform::{
  QuoteStyle, TransformOptions,
  macro_eval::{compact_expression_whitespace, remove_redundant_parentheses},
  transform_source,
};

fn default_options() -> TransformOptions {
  TransformOptions {
    env: HashMap::new(),
    quote: QuoteStyle::Double,
    preserve_key_order: false,
    source_map: false,
    inherit_process_env: false,
  }
}

fn expr_heavy_fixture() -> (String, String) {
  let filename = "expr-heavy.conf.ts".to_string();
  let mut code = String::from("import { expr } from '@conf-ts/macro';\n\n");
  code.push_str("const THRESHOLD = 10;\n");
  code.push_str("const LABEL = 'hello';\n");
  code.push_str("const ENABLED = true;\n\n");
  code.push_str(
    "type Ctx = { value: number; text: string; flag: boolean; nested: { score: number } };\n\n",
  );
  code.push_str("export default {\n");
  for i in 0..30 {
    match i % 5 {
      0 => code.push_str(&format!(
        "  prop_{i}: expr<Ctx, boolean>(ctx => ctx.value > THRESHOLD),\n"
      )),
      1 => code.push_str(&format!(
        "  prop_{i}: expr<Ctx, string>(ctx => ctx.text === LABEL),\n"
      )),
      2 => code.push_str(&format!(
        "  prop_{i}: expr<Ctx, boolean>(ctx => ctx.flag === ENABLED),\n"
      )),
      3 => code.push_str(&format!(
        "  prop_{i}: expr<Ctx, number>(ctx => ctx.nested.score + THRESHOLD),\n"
      )),
      _ => code.push_str(&format!(
        "  prop_{i}: expr<Ctx, string>(ctx => ctx.value > THRESHOLD ? LABEL : ctx.text),\n"
      )),
    }
  }
  code.push_str("};\n");
  (filename, code)
}

fn bench_transform_expr(c: &mut Criterion) {
  let (filename, code) = expr_heavy_fixture();

  c.bench_function("transform_expr_30_calls", |b| {
    b.iter(|| {
      transform_source(
        black_box(filename.clone()),
        black_box(code.clone()),
        black_box(None),
        default_options(),
      )
      .unwrap()
    });
  });
}

fn bench_remove_redundant_parentheses(c: &mut Criterion) {
  let mut group = c.benchmark_group("remove_redundant_parens");

  group.bench_function("no_parens", |b| {
    b.iter(|| remove_redundant_parentheses(black_box("a + b * c")));
  });

  group.bench_function("one_redundant", |b| {
    b.iter(|| remove_redundant_parentheses(black_box("(a) + b")));
  });

  group.bench_function("two_redundant", |b| {
    b.iter(|| remove_redundant_parentheses(black_box("(a + b) + (c + d)")));
  });

  group.bench_function("nested_redundant", |b| {
    b.iter(|| remove_redundant_parentheses(black_box("((((a + b))))")));
  });

  group.bench_function("mixed_necessary_redundant", |b| {
    b.iter(|| remove_redundant_parentheses(black_box("(a + b) * (c + d) + ((e)) + (f)")));
  });

  group.bench_function("complex_expr", |b| {
    b.iter(|| {
      remove_redundant_parentheses(black_box(
        "(value) > 10 ? (\"hello\") : (text) === (\"world\") ? (nested.score) + (10) : (\"default\")",
      ))
    });
  });

  group.finish();
}

fn bench_compact_whitespace(c: &mut Criterion) {
  let mut group = c.benchmark_group("compact_whitespace");

  group.bench_function("simple", |b| {
    b.iter(|| compact_expression_whitespace(black_box("a  +  b  *  c")));
  });

  group.bench_function("with_strings", |b| {
    b.iter(|| {
      compact_expression_whitespace(black_box(
        "value  >  10  ?  \"hello   world\"  :  'foo   bar'",
      ))
    });
  });

  group.bench_function("with_template", |b| {
    b.iter(|| {
      compact_expression_whitespace(black_box(
        "value  >  10  ?  `hello   ${  name  }   world`  :  \"fallback\"",
      ))
    });
  });

  group.bench_function("multiline_expr", |b| {
    let input =
      "value > 10\n  ? nested.score + 10\n  : text === \"world\"\n    ? nested.score\n    : 0";
    b.iter(|| compact_expression_whitespace(black_box(input)));
  });

  group.finish();
}

criterion_group!(
  benches,
  bench_transform_expr,
  bench_remove_redundant_parentheses,
  bench_compact_whitespace
);
criterion_main!(benches);
