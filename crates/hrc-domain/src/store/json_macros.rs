// Adapted from serde_json 1.0.154 macros.rs, Copyright serde-rs contributors.
// Licensed MIT OR Apache-2.0, as in the original serde_json distribution.
#[macro_export]
macro_rules! js_json {
    ($($js_json:tt)+) => {
        $crate::js_json_internal!($($js_json)+)
    };
}

#[macro_export]
#[doc(hidden)]
macro_rules! js_json_internal {

    (@array [$($elems:expr,)*]) => {
        ::std::vec![$($elems,)*]
    };

    (@array [$($elems:expr),*]) => {
        ::std::vec![$($elems),*]
    };

    (@array [$($elems:expr,)*] null $($rest:tt)*) => {
        $crate::js_json_internal!(@array [$($elems,)* $crate::js_json_internal!(null)] $($rest)*)
    };

    (@array [$($elems:expr,)*] true $($rest:tt)*) => {
        $crate::js_json_internal!(@array [$($elems,)* $crate::js_json_internal!(true)] $($rest)*)
    };

    (@array [$($elems:expr,)*] false $($rest:tt)*) => {
        $crate::js_json_internal!(@array [$($elems,)* $crate::js_json_internal!(false)] $($rest)*)
    };

    (@array [$($elems:expr,)*] [$($array:tt)*] $($rest:tt)*) => {
        $crate::js_json_internal!(@array [$($elems,)* $crate::js_json_internal!([$($array)*])] $($rest)*)
    };

    (@array [$($elems:expr,)*] {$($map:tt)*} $($rest:tt)*) => {
        $crate::js_json_internal!(@array [$($elems,)* $crate::js_json_internal!({$($map)*})] $($rest)*)
    };

    (@array [$($elems:expr,)*] $next:expr, $($rest:tt)*) => {
        $crate::js_json_internal!(@array [$($elems,)* $crate::js_json_internal!($next),] $($rest)*)
    };

    (@array [$($elems:expr,)*] $last:expr) => {
        $crate::js_json_internal!(@array [$($elems,)* $crate::js_json_internal!($last)])
    };

    (@array [$($elems:expr),*] , $($rest:tt)*) => {
        $crate::js_json_internal!(@array [$($elems,)*] $($rest)*)
    };

    (@array [$($elems:expr),*] $unexpected:tt $($rest:tt)*) => {
        $crate::js_json_unexpected!($unexpected)
    };


    (@object $object:ident () () ()) => {};

    (@object $object:ident [$($key:tt)+] ($value:expr) , $($rest:tt)*) => {
        let _ = $object.insert(($($key)+).into(), $value);
        $crate::js_json_internal!(@object $object () ($($rest)*) ($($rest)*));
    };

    (@object $object:ident [$($key:tt)+] ($value:expr) $unexpected:tt $($rest:tt)*) => {
        $crate::js_json_unexpected!($unexpected);
    };

    (@object $object:ident [$($key:tt)+] ($value:expr)) => {
        let _ = $object.insert(($($key)+).into(), $value);
    };

    (@object $object:ident ($($key:tt)+) (: null $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object [$($key)+] ($crate::js_json_internal!(null)) $($rest)*);
    };

    (@object $object:ident ($($key:tt)+) (: true $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object [$($key)+] ($crate::js_json_internal!(true)) $($rest)*);
    };

    (@object $object:ident ($($key:tt)+) (: false $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object [$($key)+] ($crate::js_json_internal!(false)) $($rest)*);
    };

    (@object $object:ident ($($key:tt)+) (: [$($array:tt)*] $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object [$($key)+] ($crate::js_json_internal!([$($array)*])) $($rest)*);
    };

    (@object $object:ident ($($key:tt)+) (: {$($map:tt)*} $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object [$($key)+] ($crate::js_json_internal!({$($map)*})) $($rest)*);
    };

    (@object $object:ident ($($key:tt)+) (: $value:expr , $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object [$($key)+] ($crate::js_json_internal!($value)) , $($rest)*);
    };

    (@object $object:ident ($($key:tt)+) (: $value:expr) $copy:tt) => {
        $crate::js_json_internal!(@object $object [$($key)+] ($crate::js_json_internal!($value)));
    };

    (@object $object:ident ($($key:tt)+) (:) $copy:tt) => {
        $crate::js_json_internal!();
    };

    (@object $object:ident ($($key:tt)+) () $copy:tt) => {
        $crate::js_json_internal!();
    };

    (@object $object:ident () (: $($rest:tt)*) ($colon:tt $($copy:tt)*)) => {
        $crate::js_json_unexpected!($colon);
    };

    (@object $object:ident ($($key:tt)*) (, $($rest:tt)*) ($comma:tt $($copy:tt)*)) => {
        $crate::js_json_unexpected!($comma);
    };

    (@object $object:ident () (($key:expr) : $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object ($key) (: $($rest)*) (: $($rest)*));
    };

    (@object $object:ident ($($key:tt)*) (: $($unexpected:tt)+) $copy:tt) => {
        $crate::js_json_expect_expr_comma!($($unexpected)+);
    };

    (@object $object:ident ($($key:tt)*) ($tt:tt $($rest:tt)*) $copy:tt) => {
        $crate::js_json_internal!(@object $object ($($key)* $tt) ($($rest)*) ($($rest)*));
    };


    (null) => {
        $crate::store::json::Value::Null
    };

    (true) => {
        $crate::store::json::Value::Bool(true)
    };

    (false) => {
        $crate::store::json::Value::Bool(false)
    };

    ([]) => {
        $crate::store::json::Value::Array(::std::vec![])
    };

    ([ $($tt:tt)+ ]) => {
        $crate::store::json::Value::Array($crate::js_json_internal!(@array [] $($tt)+))
    };

    ({}) => {
        $crate::store::json::Value::Object($crate::store::json::Map::new())
    };

    ({ $($tt:tt)+ }) => {
        $crate::store::json::Value::Object({
            let mut object = $crate::store::json::Map::new();
            $crate::js_json_internal!(@object object () ($($tt)+) ($($tt)+));
            object
        })
    };

    ($other:expr) => {
        $crate::store::json::to_value(&$other).unwrap()
    };
}

#[macro_export]
#[doc(hidden)]
macro_rules! js_json_internal_vec {
    ($($content:tt)*) => {
        vec![$($content)*]
    };
}

#[macro_export]
#[doc(hidden)]
macro_rules! js_json_unexpected {
    () => {};
}

#[macro_export]
#[doc(hidden)]
macro_rules! js_json_expect_expr_comma {
    ($e:expr , $($tt:tt)*) => {};
}
