//! Images the composer holds: a thumbnail for each chip, and a pasted image scaled for the
//! model as Desktop's view scales it on a canvas.

use crate::attachments::scaled_size;
use image::{DynamicImage, ImageFormat, imageops::FilterType};
use std::io::Cursor;

/// The longest edge a chip's thumbnail is drawn from.
const THUMB: u32 = 64;

/// A thumbnail's RGBA pixels, width and height; none for bytes no decoder reads.
pub fn thumbnail(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let image = image::load_from_memory(bytes).ok()?;
    let small = image.thumbnail(THUMB, THUMB).to_rgba8();
    Some((small.width(), small.height(), small.into_raw()))
}

/// A PNG scaled to 2000 points on its long edge, where it is longer; none where it fits.
pub fn scaled_png(png: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory_with_format(png, ImageFormat::Png).ok()?;
    let (width, height) = scaled_size(image.width(), image.height())?;
    let smaller = DynamicImage::ImageRgba8(
        image
            .resize_exact(width, height, FilterType::Triangle)
            .to_rgba8(),
    );
    let mut out = Cursor::new(Vec::new());
    smaller.write_to(&mut out, ImageFormat::Png).ok()?;
    Some(out.into_inner())
}
