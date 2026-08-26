use anchor_lang::prelude::*;

use crate::constants::MAX_WOOD_PER_TREE;

#[account]
pub struct GameData {
    pub total_wood_collected: u64,
}

impl GameData {
    pub fn on_tree_chopped(&mut self, amount_chopped: u64) -> Result<()> {
        match self.total_wood_collected.checked_add(amount_chopped) {
            Some(v) => {
                if self.total_wood_collected >= MAX_WOOD_PER_TREE {
                    self.total_wood_collected = 0;
                    msg!("Tree successfully chopped. New Tree coming up.");
                } else {
                    self.total_wood_collected = v;
                    msg!("Total wood chopped: {}", v);
                }
            }
            None => {
                msg!("The ever tree is completly chopped!");
            }
        };

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_counting_below_max() {
        let mut game = GameData {
            total_wood_collected: 0,
        };
        game.on_tree_chopped(1).unwrap();
        assert_eq!(game.total_wood_collected, 1);
    }

    #[test]
    fn resets_when_total_reaches_max() {
        let mut game = GameData {
            total_wood_collected: MAX_WOOD_PER_TREE - 1,
        };
        game.on_tree_chopped(1).unwrap();
        assert_eq!(game.total_wood_collected, 0);
    }
}
