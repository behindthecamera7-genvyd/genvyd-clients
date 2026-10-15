-- Carousel copy: which card a line belongs to (NULL = the whole ad, e.g. primary text and button).
ALTER TABLE copy_items ADD COLUMN card INTEGER;
