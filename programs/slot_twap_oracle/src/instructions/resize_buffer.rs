use anchor_lang::prelude::*;

use crate::errors::OracleError;
use crate::events::BufferResized;
use crate::state::{ObservationBuffer, Oracle};

#[derive(Accounts)]
#[instruction(new_capacity: u32)]
pub struct ResizeBuffer<'info> {
    #[account(
        seeds = [b"oracle", oracle.base_mint.as_ref(), oracle.quote_mint.as_ref()],
        bump,
        has_one = owner,
    )]
    pub oracle: Account<'info, Oracle>,

    #[account(
        mut,
        has_one = oracle,
        seeds = [b"observation", oracle.key().as_ref()],
        bump,
        realloc = ObservationBuffer::space(new_capacity),
        realloc::payer = owner,
        realloc::zero = false,
    )]
    pub observation_buffer: Account<'info, ObservationBuffer>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ResizeBuffer>, new_capacity: u32) -> Result<()> {
    require!(new_capacity > 0, OracleError::InvalidCapacity);

    let buffer = &mut ctx.accounts.observation_buffer;
    let old_capacity = buffer.capacity;
    let len = buffer.observations.len();

    if new_capacity < old_capacity && len > 0 {
        // Shrinking: linearize the ring in chronological order (oldest first),
        // then keep only the most recent `new_capacity` entries.
        let head = buffer.head as usize;
        let mut ordered = Vec::with_capacity(len);

        if len < old_capacity as usize {
            // Buffer not yet full — observations[0..len] are already in order
            ordered.extend_from_slice(&buffer.observations[..len]);
        } else {
            // Buffer full and possibly wrapped — head points to the oldest entry
            ordered.extend_from_slice(&buffer.observations[head..]);
            ordered.extend_from_slice(&buffer.observations[..head]);
        }

        // Keep only the most recent entries that fit the new capacity
        let keep = (new_capacity as usize).min(ordered.len());
        let start = ordered.len() - keep;
        buffer.observations = ordered[start..].to_vec();
        buffer.head = buffer.observations.len() as u32 % new_capacity;
    }

    // If growing, observations stay as-is; new slots will be filled by push_observation.
    buffer.capacity = new_capacity;

    emit!(BufferResized {
        oracle: ctx.accounts.oracle.key(),
        old_capacity,
        new_capacity,
        observations_retained: buffer.observations.len() as u32,
    });

    Ok(())
}
