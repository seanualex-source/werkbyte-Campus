// Unter Windows im Release kein zusätzliches Konsolenfenster öffnen.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    werkbyte_campus_lib::run()
}
