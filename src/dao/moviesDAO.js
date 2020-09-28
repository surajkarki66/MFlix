import { ObjectId } from "bson"

const DEFAULT_SORT = [["tomatoes.viewer.numReviews", -1]]

export default class MoviesDAO {
  static #movies
  static #mflix
  static async injectDB(conn) {
    if (MoviesDAO.#movies) {
      return
    }
    try {
      MoviesDAO.#mflix = await conn.db(process.env.MFLIX_NS)
      MoviesDAO.#movies = await conn
        .db(process.env.MFLIX_NS)
        .collection("movies")
    } catch (e) {
      console.error(
        `Unable to establish a collection handle in moviesDAO: ${e}`,
      )
    }
  }

  /**
   * Retrieves the connection pool size, write concern and user roles on the
   * current client.
   * @returns {Promise<ConfigurationResult>} An object with configuration details.
   */
  static async getConfiguration() {
    const roleInfo = await MoviesDAO.#mflix.command({ connectionStatus: 1 })
    const authInfo = roleInfo.authInfo.authenticatedUserRoles[0]
    const { poolSize, wtimeout } = MoviesDAO.#movies.s.db.serverConfig.s.options
    let response = {
      poolSize,
      wtimeout,
      authInfo,
    }
    return response
  }

  /**
   * Finds and returns movies originating from one or more countries.
   * Returns a list of objects, each object contains a title and an _id.
   * @param {string[]} countries - The list of countries.
   * @returns {Promise<CountryResult>} A promise that will resolve to a list of CountryResults.
   */
  static async getMoviesByCountry(countries) {
    let cursor
    try {
      cursor = await MoviesDAO.#movies.find(
        { countries: { $in: countries } },
        { projection: { title: 1 } },
      )
    } catch (e) {
      console.error(`Unable to issue find command, ${e}`)
      return []
    }

    return cursor.toArray()
  }

  /**
   * Finds and returns movies matching a given text in their title or description.
   * @param {string} text - The text to match with.
   * @returns {QueryParams} The QueryParams for text search
   */
  static textSearchQuery(text) {
    const query = { $text: { $search: text } }
    const meta_score = { $meta: "textScore" }
    const sort = [["score", meta_score]]
    const project = { score: meta_score }

    return { query, project, sort }
  }

  /**
   * Finds and returns movies including one or more cast members.
   * @param {string[]} cast - The cast members to match with.
   * @returns {QueryParams} The QueryParams for cast search
   */
  static castSearchQuery(cast) {
    const searchCast = Array.isArray(cast) ? cast : cast.split(", ")

    const query = { cast: { $in: searchCast } }
    const project = {}
    const sort = DEFAULT_SORT

    return { query, project, sort }
  }

  /**
   * Finds and returns movies matching a one or more genres.
   * @param {string[]} genre - The genres to match with.
   * @returns {QueryParams} The QueryParams for genre search
   */
  static genreSearchQuery(genre) {
    const searchGenre = Array.isArray(genre) ? genre : genre.split(", ")

    const query = { genres: { $in: searchGenre } }
    const project = {}
    const sort = DEFAULT_SORT

    return { query, project, sort }
  }

  /**
   *
   * @param {Object} filters - The search parameter to use in the query. Comes
   * in the form of `{cast: { $in: [...castMembers]}}`
   * @param {number} page - The page of movies to retrieve.
   * @param {number} moviesPerPage - The number of movies to display per page.
   * @returns {FacetedSearchReturn} FacetedSearchReturn
   */
  static async facetedSearch({
    filters = null,
    page = 0,
    moviesPerPage = 20,
  } = {}) {
    if (!filters || !filters.cast) {
      throw new Error("Must specify cast members to filter by.")
    }
    const matchStage = { $match: filters }
    const sortStage = { $sort: { "tomatoes.viewer.numReviews": -1 } }
    const countingPipeline = [matchStage, sortStage, { $count: "count" }]
    const skipStage = { $skip: moviesPerPage * page }
    const limitStage = { $limit: moviesPerPage }
    const facetStage = {
      $facet: {
        runtime: [
          {
            $bucket: {
              groupBy: "$runtime",
              boundaries: [0, 60, 90, 120, 180],
              default: "other",
              output: {
                count: { $sum: 1 },
              },
            },
          },
        ],
        rating: [
          {
            $bucket: {
              groupBy: "$metacritic",
              boundaries: [0, 50, 70, 90, 100],
              default: "other",
              output: {
                count: { $sum: 1 },
              },
            },
          },
        ],
        movies: [
          {
            $addFields: {
              title: "$title",
            },
          },
        ],
      },
    }

    const queryPipeline = [
      matchStage,
      sortStage,
      skipStage,
      limitStage,
      facetStage,
    ]

    try {
      const results = await (
        await MoviesDAO.#movies.aggregate(queryPipeline)
      ).next()
      const count = await (
        await MoviesDAO.#movies.aggregate(countingPipeline)
      ).next()
      return {
        ...results,
        ...count,
      }
    } catch (e) {
      return { error: "Results too large, be more restrictive in filter" }
    }
  }

  /**
   * Finds and returns movies by country.
   * Returns a list of objects, each object contains a title and an _id.
   * @param {Object} filters - The search parameters to use in the query.
   * @param {number} page - The page of movies to retrieve.
   * @param {number} moviesPerPage - The number of movies to display per page.
   * @returns {GetMoviesResult} An object with movie results and total results
   * that would match this query
   */
  static async getMovies({
    // here's where the default parameters are set for the getMovies method
    filters = null,
    page = 0,
    moviesPerPage = 20,
  } = {}) {
    let queryParams = {}
    if (filters) {
      if ("text" in filters) {
        queryParams = this.textSearchQuery(filters["text"])
      } else if ("cast" in filters) {
        queryParams = this.castSearchQuery(filters["cast"])
      } else if ("genre" in filters) {
        queryParams = this.genreSearchQuery(filters["genre"])
      }
    }

    let { query = {}, project = {}, sort = DEFAULT_SORT } = queryParams
    let cursor
    try {
      cursor = await MoviesDAO.#movies
        .find(query)
        .project(project)
        .sort(sort)
    } catch (e) {
      console.error(`Unable to issue find command, ${e}`)
      return { moviesList: [], totalNumMovies: 0 }
    }

    const displayCursor = cursor.skip(page * moviesPerPage).limit(moviesPerPage)
    try {
      const moviesList = await displayCursor.toArray()
      const totalNumMovies =
        page === 0 ? await MoviesDAO.#movies.countDocuments(query) : 0
      return { moviesList, totalNumMovies }
    } catch (e) {
      console.error(
        `Unable to convert cursor to array or problem counting documents, ${e}`,
      )
      return { moviesList: [], totalNumMovies: 0 }
    }
  }

  /**
   * Gets a movie by its id
   * @param {string} id - The desired movie id, the _id in Mongo
   * @returns {MflixMovie | null} Returns either a single movie or nothing
   */
  static async getMovieByID(id) {
    try {
      const pipeline = [
        {
          $match: {
            _id: ObjectId(id),
          },
        },
        {
          $lookup: {
            // it is a join method
            from: "comments",
            let: { id: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$movie_id", "$$id"],
                  },
                },
              },
              { $sort: { date: -1 } },
            ],
            as: "comments",
          },
        },
      ]
      return await MoviesDAO.#movies.aggregate(pipeline).next()
    } catch (e) {
      // here's how the InvalidId error is identified and handled
      if (
        e
          .toString()
          .startsWith(
            "Error: Argument passed in must be a single String of 12 bytes or a string of 24 hex characters",
          )
      ) {
        return null
      }
      // if (e.name === "Error") {return null} also good
      console.error(`Something went wrong in getMovieByID: ${e}`)
      throw e
    }
  }
}

/**
 * This is a parsed query, sort, and project bundle.
 * @typedef QueryParams
 * @property {Object} query - The specified query, transformed accordingly
 * @property {any[]} sort - The specified sort
 * @property {Object} project - The specified project, if any
 */

/**
 * Represents a single country result
 * @typedef CountryResult
 * @property {string} ObjectID - The ObjectID of the movie
 * @property {string} title - The title of the movie
 */

/**
 * A Movie from mflix
 * @typedef MflixMovie
 * @property {string} _id
 * @property {string} title
 * @property {number} year
 * @property {number} runtime
 * @property {Date} released
 * @property {string[]} cast
 * @property {number} metacriticd
 * @property {string} poster
 * @property {string} plot
 * @property {string} fullplot
 * @property {string|Date} lastupdated
 * @property {string} type
 * @property {string[]} languages
 * @property {string[]} directors
 * @property {string[]} writers
 * @property {IMDB} imdb
 * @property {string[]} countries
 * @property {string[]} rated
 * @property {string[]} genres
 * @property {string[]} comments
 */

/**
 * IMDB subdocument
 * @typedef IMDB
 * @property {number} rating
 * @property {number} votes
 * @property {number} id
 */

/**
 * Result set for getMovies method
 * @typedef GetMoviesResult
 * @property {MflixMovies[]} moviesList
 * @property {number} totalNumResults
 */

/**
 * Faceted Search Return
 *
 * The type of return from faceted search. It will be a single document with
 * 3 fields: rating, runtime, and movies.
 * @typedef FacetedSearchReturn
 * @property {object} rating
 * @property {object} runtime
 * @property {MFlixMovie[]}movies
 */
