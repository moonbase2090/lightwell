pub mod inline {
    pub mod nested;
}

#[path = "alternate.rs"]
pub mod alternate;

#[cfg(test)]
mod tests {
    pub mod ignored;
}
