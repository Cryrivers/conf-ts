use std::collections::HashMap;

use compiler_native::browser::compile_in_memory;
use compiler_native::compiler::parse_ts_file;
use compiler_native::types::{CompileOptions, NumberValue, Value, serialize_output};
use criterion::{Criterion, black_box, criterion_group, criterion_main};
use indexmap::IndexMap;

fn small_fixture() -> (HashMap<String, String>, &'static str) {
  let mut files = HashMap::new();
  files.insert(
    "entry.conf.ts".to_string(),
    r#"
export default {
  a: 1,
  b: 'hello',
  c: true,
  d: null,
  e: {
    f: 1.23,
    g: 'world',
  },
  h: [1, 2, 3],
  i: ['a', 'b', 'c'],
};
"#
    .to_string(),
  );
  (files, "entry.conf.ts")
}

fn medium_fixture() -> (HashMap<String, String>, &'static str) {
  let mut files = HashMap::new();

  files.insert(
    "constants.ts".to_string(),
    r#"
export const APP_NAME = 'my-app';
export const VERSION = '1.0.0';
export const MAX_RETRIES = 3;
export const TIMEOUT_MS = 5000;
export const FEATURE_FLAGS = {
  darkMode: true,
  newDashboard: false,
  betaFeatures: true,
};
"#
    .to_string(),
  );

  files.insert(
    "enums.ts".to_string(),
    r#"
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}
export enum Environment {
  Development = 'development',
  Staging = 'staging',
  Production = 'production',
}
"#
    .to_string(),
  );

  let mut entry = String::from(
    r#"import { APP_NAME, VERSION, MAX_RETRIES, TIMEOUT_MS, FEATURE_FLAGS } from './constants';
import { LogLevel, Environment } from './enums';

export default {
  app: {
    name: APP_NAME,
    version: VERSION,
  },
  retry: {
    maxRetries: MAX_RETRIES,
    timeoutMs: TIMEOUT_MS,
  },
  features: FEATURE_FLAGS,
  logging: {
    level: LogLevel.Info,
    environment: Environment.Production,
  },
"#,
  );
  for i in 0..40 {
    entry.push_str(&format!(
      "  prop_{}: {{ key: 'value_{}', nested: {{ a: {}, b: '{}' }} }},\n",
      i, i, i, i
    ));
  }
  entry.push_str("};\n");
  files.insert("entry.conf.ts".to_string(), entry);

  (files, "entry.conf.ts")
}

fn large_fixture() -> (HashMap<String, String>, &'static str) {
  let mut files = HashMap::new();

  let mut shared = String::from("export const BASE = { version: 1 };\n");
  for i in 0..20 {
    shared.push_str(&format!(
      "export const SHARED_{} = {{ id: {}, name: 'shared_{}', enabled: {} }};\n",
      i,
      i,
      i,
      i % 2 == 0
    ));
  }
  files.insert("shared.ts".to_string(), shared);

  files.insert(
    "enums.ts".to_string(),
    r#"
export enum Status { Active = 'active', Inactive = 'inactive', Pending = 'pending' }
export enum Priority { Low = 0, Medium = 1, High = 2, Critical = 3 }
export enum Region { US = 'us', EU = 'eu', APAC = 'apac' }
"#
    .to_string(),
  );

  for module_idx in 0..4 {
    let mut module = format!(
      "import {{ SHARED_{idx} }} from './shared';\n\
       export const CONFIG_{idx} = {{\n\
         ...SHARED_{idx},\n",
      idx = module_idx
    );
    for prop in 0..20 {
      module.push_str(&format!(
        "  field_{}_{}: {{ value: {}, label: 'item_{}' }},\n",
        module_idx, prop, prop, prop
      ));
    }
    module.push_str("};\n");
    files.insert(format!("module_{}.ts", module_idx), module);
  }

  let mut entry = String::new();
  for i in 0..4 {
    entry.push_str(&format!("import {{ CONFIG_{i} }} from './module_{i}';\n"));
  }
  entry.push_str(
    "import { Status, Priority, Region } from './enums';\n\
     import { BASE } from './shared';\n\n\
     export default {\n\
       base: BASE,\n\
       status: Status.Active,\n\
       priority: Priority.High,\n\
       region: Region.US,\n",
  );
  for i in 0..4 {
    entry.push_str(&format!("  config_{i}: CONFIG_{i},\n"));
  }
  for i in 0..40 {
    entry.push_str(&format!(
      "  extra_{i}: {{ id: {i}, tags: ['tag_a', 'tag_b'], meta: {{ x: {val}, y: '{i}' }} }},\n",
      val = i * 10
    ));
  }
  entry.push_str("};\n");
  files.insert("entry.conf.ts".to_string(), entry);

  (files, "entry.conf.ts")
}

fn build_value(n: usize) -> Value {
  let mut props = IndexMap::new();
  for i in 0..n {
    props.insert(
      format!("key_{}", i),
      Value::Object(IndexMap::from([
        ("name".to_string(), Value::String(format!("item_{}", i))),
        (
          "value".to_string(),
          Value::Number(NumberValue {
            value: i as f64,
            raw: None,
          }),
        ),
        ("enabled".to_string(), Value::Bool(i % 2 == 0)),
      ])),
    );
  }
  Value::Object(props)
}

fn bench_parse(c: &mut Criterion) {
  let (small_files, small_entry) = small_fixture();
  let (medium_files, medium_entry) = medium_fixture();
  let (large_files, large_entry) = large_fixture();

  let mut group = c.benchmark_group("parse");
  group.bench_function("small", |b| {
    let source = &small_files[small_entry];
    b.iter(|| parse_ts_file(black_box(source), black_box(small_entry)).unwrap());
  });
  group.bench_function("medium", |b| {
    let source = &medium_files[medium_entry];
    b.iter(|| parse_ts_file(black_box(source), black_box(medium_entry)).unwrap());
  });
  group.bench_function("large", |b| {
    let source = &large_files[large_entry];
    b.iter(|| parse_ts_file(black_box(source), black_box(large_entry)).unwrap());
  });
  group.finish();
}

fn bench_end_to_end(c: &mut Criterion) {
  let (small_files, small_entry) = small_fixture();
  let (medium_files, medium_entry) = medium_fixture();
  let (large_files, large_entry) = large_fixture();
  let options = CompileOptions::default();

  let mut group = c.benchmark_group("end_to_end");
  group.bench_function("small_json", |b| {
    b.iter(|| {
      compile_in_memory(
        black_box(&small_files),
        black_box(small_entry),
        "json",
        &options,
      )
      .unwrap()
    });
  });
  group.bench_function("medium_json", |b| {
    b.iter(|| {
      compile_in_memory(
        black_box(&medium_files),
        black_box(medium_entry),
        "json",
        &options,
      )
      .unwrap()
    });
  });
  group.bench_function("large_json", |b| {
    b.iter(|| {
      compile_in_memory(
        black_box(&large_files),
        black_box(large_entry),
        "json",
        &options,
      )
      .unwrap()
    });
  });
  group.bench_function("large_yaml", |b| {
    b.iter(|| {
      compile_in_memory(
        black_box(&large_files),
        black_box(large_entry),
        "yaml",
        &options,
      )
      .unwrap()
    });
  });
  group.finish();
}

fn bench_serialize(c: &mut Criterion) {
  let small = build_value(10);
  let medium = build_value(50);
  let large = build_value(200);

  let mut group = c.benchmark_group("serialize");
  group.bench_function("small_json", |b| {
    b.iter(|| serialize_output(black_box(&small), "json").unwrap());
  });
  group.bench_function("medium_json", |b| {
    b.iter(|| serialize_output(black_box(&medium), "json").unwrap());
  });
  group.bench_function("large_json", |b| {
    b.iter(|| serialize_output(black_box(&large), "json").unwrap());
  });
  group.bench_function("large_yaml", |b| {
    b.iter(|| serialize_output(black_box(&large), "yaml").unwrap());
  });
  group.finish();
}

criterion_group!(benches, bench_parse, bench_end_to_end, bench_serialize);
criterion_main!(benches);
